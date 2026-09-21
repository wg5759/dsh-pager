/**
 * Notification hub: the few moments worth buzzing a phone in someone's pocket.
 *
 * One long-lived watcher per DSH process listens to DSH's own mux + host
 * WebSockets and distils them into rare, self-contained notices:
 *
 *   ask / askDone   an approval is waiting / was settled
 *   q / qDone       an ask_user question is waiting / was settled
 *   done            a turn finished (long enough to matter, or sent from the phone)
 *   err             a turn or agent failed
 *
 * Notices carry a monotonically increasing `n` and live in a ring buffer, so a
 * phone that lost signal for a while replays exactly what it missed
 * (`?since=<n>&epoch=<e>`); `epoch` changes when DSH restarts. Still-pending
 * approvals/questions are re-sent on every connect. Heartbeats are sparse
 * (`?hb=`, default 120 s) because this stream keeps a phone radio awake.
 *
 * Unlike /m/api/events there is no per-token traffic here: a whole task is a
 * handful of frames, which is what makes an always-on background connection
 * affordable on battery.
 */

import crypto from 'node:crypto'
import { foldAssistant, foldCall } from './fold.js'

/** Turns shorter than this only notify when the phone sent the prompt. */
export const MIN_NOTIFY_MS = 10000

/**
 * Decide what a finished turn deserves.
 * @param {{kind: string, ms?: number, phone?: boolean, sub?: boolean}} t
 * @returns {'done'|'error'|null}
 */
export function turnEndNotice({ kind, ms, phone, sub }) {
  if (sub) return null // subagent turns are internal steps of a parent task
  if (kind === 'completed') return ms === undefined || ms >= MIN_NOTIFY_MS || phone ? 'done' : null
  if (/error|fail/i.test(kind || '')) return 'error'
  return null // interrupted / aborted / cancelled: the user (or a restart) stopped it
}

/** Plain one-paragraph preview of assistant Markdown. */
export function previewText(md, n = 90) {
  const s = String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

export function cleanTitle(t) {
  return String(t || '').replace(/\*\*|__|`/g, '').replace(/^\s*(session\s*)?title\s*[:：]\s*/i, '').trim()
}

const REPLAY_WINDOW_MS = 6 * 3600 * 1000

export class NotifyHub {
  /**
   * @param {{ wsBase: () => string, listSessions: () => Promise<{items: any[]}>, log?: (m: string) => void }} opts
   */
  constructor({ wsBase, listSessions, log = () => {} }) {
    this.wsBase = wsBase
    this.listSessions = listSessions
    this.log = log
    this.epoch = crypto.randomUUID().slice(0, 8)
    this.n = 0
    this.buf = []
    this.clients = new Set()
    this.titles = new Map()
    this.sub = new Set()
    this.lastText = new Map()
    this.turnAt = new Map()
    this.phone = new Set()
    this.calls = new Map()
    this.asks = new Map()
    this.qs = new Map()
    this.sockets = []
    this.started = false
    this.stopped = false
    this.timer = null
  }

  start() {
    if (this.started || this.stopped) return
    this.started = true
    this.connect()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    for (const ws of this.sockets) { try { ws.close() } catch {} }
    for (const c of [...this.clients]) c.close()
  }

  /** The phone sent a prompt: notify this session's turn end even if it is quick. */
  markPhone(sessionId) {
    if (typeof sessionId === 'string') this.phone.add(sessionId)
  }

  title(s) {
    return cleanTitle(this.titles.get(s)) || '对话'
  }

  async refresh() {
    try {
      const v = await this.listSessions()
      for (const s of v.items || []) {
        const t = s.projections && s.projections.values && s.projections.values.title
        if (typeof t === 'string' && t) this.titles.set(s.sessionId, t)
        if (s.origin === 'subagent') this.sub.add(s.sessionId)
      }
    } catch (err) {
      this.log(`notify: session list failed: ${err && err.message}`)
    }
  }

  connect() {
    if (this.stopped) return
    // The fresh mux replays everything still pending; whatever it does not
    // replay was settled while we were away and must be withdrawn on phones.
    const prevAsks = new Map(this.asks)
    const prevQs = new Map(this.qs)
    this.asks.clear()
    this.qs.clear()
    this.prevAsks = prevAsks
    this.prevQs = prevQs
    let down = false
    const onDown = () => {
      if (down) return
      down = true
      for (const ws of this.sockets) { try { ws.close() } catch {} }
      if (!this.stopped) this.timer = setTimeout(() => this.connect(), 3000)
    }
    const open = (path, handler) => {
      const ws = new WebSocket(this.wsBase() + path)
      ws.onmessage = (ev) => { try { handler(JSON.parse(ev.data)) } catch (err) { this.log(`notify: frame error: ${err && err.message}`) } }
      ws.onerror = () => {}
      ws.onclose = onDown
      return ws
    }
    this.sockets = [open('/api/events.mux', (e) => this.onMux(e)), open('/api/events.host', (e) => this.onHost(e))]
    this.refresh()
    setTimeout(() => this.settleReplay(), 4000)
  }

  settleReplay() {
    for (const [id, a] of this.prevAsks || []) if (!this.asks.has(id)) this.emit({ t: 'askDone', s: a.s, id })
    for (const [rpc, q] of this.prevQs || []) if (!this.qs.has(rpc)) this.emit({ t: 'qDone', s: q.s, rpc })
    this.prevAsks = null
    this.prevQs = null
  }

  emit(ev) {
    ev.n = ++this.n
    ev.at = Date.now()
    this.buf.push(ev)
    if (this.buf.length > 200) this.buf.shift()
    for (const c of this.clients) c.send(ev)
    for (const fn of this.listeners || []) { try { fn(ev) } catch (err) { this.log(`notice listener failed: ${err && err.message}`) } }
    return ev
  }

  /** Also deliver every notice to `fn` (Web Push); returns the unsubscribe. */
  onNotice(fn) {
    if (!this.listeners) this.listeners = new Set()
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onMux(env) {
    const f = env && env.payload
    if (!f) return
    const s = f.sessionId
    switch (f.type) {
      case 'session/event':
        return this.onEvent(s, f.event, f.view)
      case 'approval/requested': {
        const call = this.calls.get(f.callId) || {}
        const a = { t: 'ask', s, title: this.title(s), rpc: env.rpcId, id: f.approvalId, tool: f.toolName, what: call.title || f.reason || f.toolName, detail: call.detail || '' }
        const known = this.asks.has(f.approvalId) || (this.prevAsks && this.prevAsks.has(f.approvalId))
        this.asks.set(f.approvalId, a)
        if (!known) this.emit(a)
        return
      }
      case 'approval/resolved':
        if (this.asks.delete(f.approvalId)) this.emit({ t: 'askDone', s, id: f.approvalId })
        return
      case 'question/requested': {
        const first = (f.questions || [])[0] || {}
        const q = { t: 'q', s, title: this.title(s), rpc: env.rpcId, text: first.question || '有问题需要你回答', count: (f.questions || []).length }
        const known = this.qs.has(env.rpcId) || (this.prevQs && this.prevQs.has(env.rpcId))
        this.qs.set(env.rpcId, q)
        if (!known) this.emit(q)
        return
      }
      case 'question/resolved':
        if (this.qs.delete(f.questionRpcId)) this.emit({ t: 'qDone', s, rpc: f.questionRpcId })
        return
      case 'session/projection':
        if (f.key === 'title' && typeof f.value === 'string') this.titles.set(s, f.value)
        return
    }
  }

  onEvent(s, e, view) {
    if (!e) return
    switch (e.type) {
      case 'turn/start':
        this.turnAt.set(s, e.time)
        this.lastText.delete(s)
        return
      case 'assistant/message': {
        const a = foldAssistant(e)
        if (a && a.text) this.lastText.set(s, a.text)
        return
      }
      case 'tool/call': {
        const it = foldCall(e, view)
        this.calls.set(it.id, { title: it.title, detail: it.detail })
        if (this.calls.size > 300) this.calls.delete(this.calls.keys().next().value)
        return
      }
      case 'session/title':
        if (e.data && e.data.title) this.titles.set(s, e.data.title)
        return
      case 'turn/end': {
        const kind = (e.data && e.data.reason && e.data.reason.kind) || 'completed'
        const at = this.turnAt.get(s)
        const ms = at !== undefined ? e.time - at : undefined
        const verdict = turnEndNotice({ kind, ms, phone: this.phone.has(s), sub: this.sub.has(s) })
        if (verdict === 'done') this.emit({ t: 'done', s, title: this.title(s), ms, preview: previewText(this.lastText.get(s)) })
        else if (verdict === 'error') this.emit({ t: 'err', s, title: this.title(s), msg: kind })
        this.turnAt.delete(s)
        this.phone.delete(s)
        this.lastText.delete(s)
        return
      }
    }
  }

  onHost(env) {
    const f = env && env.payload
    if (!f) return
    if (f.type === 'host/session-added' && f.origin === 'subagent') this.sub.add(f.sessionId)
    else if (f.type === 'host/agent-error' && !this.sub.has(f.sessionId)) this.emit({ t: 'err', s: f.sessionId, title: this.title(f.sessionId), msg: f.message })
  }

  /**
   * Attach one SSE response.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{ since?: number, epoch?: string, hb?: number }} opts
   */
  subscribe(req, res, { since, epoch, hb = 120 } = {}) {
    this.start()
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' })
    res.write('retry: 5000\n\n')
    let open = true
    const client = {
      send: (ev) => { if (open) { try { res.write(`data: ${JSON.stringify(ev)}\n\n`) } catch { client.close() } } },
      close: () => {
        if (!open) return
        open = false
        clearInterval(ping)
        this.clients.delete(client)
        try { res.end() } catch {}
      },
    }
    client.send({ t: 'hello', epoch: this.epoch, n: this.n })
    if (epoch === this.epoch && Number.isFinite(since)) {
      const cutoff = Date.now() - REPLAY_WINDOW_MS
      for (const ev of this.buf) if (ev.n > since && ev.at >= cutoff && ev.t !== 'ask' && ev.t !== 'q') client.send(ev)
    }
    for (const a of this.asks.values()) client.send({ ...a, replay: true })
    for (const q of this.qs.values()) client.send({ ...q, replay: true })
    this.clients.add(client)
    const ping = setInterval(() => client.send({ t: 'p' }), Math.min(300, Math.max(20, hb)) * 1000)
    req.on('close', () => client.close())
  }
}
