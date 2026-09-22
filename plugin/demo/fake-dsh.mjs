/**
 * A stand-in DSH for demos and screenshots.
 *
 * The real plugin (server.js, fold.js, notify.js, the phone UI) talks to this
 * over DSH's own wire protocol, unchanged:
 *   POST /api/<method>            client-request -> server-response
 *   POST /api/respond             answers to approvals and questions
 *   WS   /api/events.mux|host     server-request frames
 * and gets made-up projects and sessions from content.mjs: finished turns with
 * every tool card, a turn waiting for an approval, one waiting for an answer,
 * and streamed replies to whatever the phone sends. No real session, path or
 * account ever appears, and nothing on disk outside the demo root is touched.
 *
 *   import { startDemo } from './demo/fake-dsh.mjs'   (see dev.mjs --demo)
 */

import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { writeProjects, sessions as demoSessions, book, reply, FOLLOW_UP, writeAgentSessions } from './content.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- a minimal WebSocket server (RFC 6455): text frames out, close/ping in ----

function acceptSocket(req, socket, onClose) {
  const key = req.headers['sec-websocket-key']
  if (!key) { socket.destroy(); return null }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  socket.setNoDelay(true)
  const frame = (opcode, payload) => {
    const n = payload.length
    let head
    if (n < 126) head = Buffer.from([0x80 | opcode, n])
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2) }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2) }
    return Buffer.concat([head, payload])
  }
  let buf = Buffer.alloc(0)
  let closed = false
  const peer = {
    send(obj) { if (!closed) socket.write(frame(0x1, Buffer.from(JSON.stringify(obj)))) },
    close() { if (!closed) { closed = true; try { socket.end(frame(0x8, Buffer.alloc(0))) } catch {} } },
  }
  // Client frames are masked; only close and ping matter here.
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f
      let len = buf[1] & 0x7f
      let off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      const masked = buf[1] & 0x80
      if (buf.length < off + (masked ? 4 : 0) + len) return
      const mask = masked ? buf.subarray(off, off + 4) : null
      const body = Buffer.from(buf.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len))
      if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3]
      buf = buf.subarray(off + (masked ? 4 : 0) + len)
      if (op === 0x8) { peer.close(); return }
      if (op === 0x9 && !closed) socket.write(frame(0xa, body))
    }
  })
  const done = () => { closed = true; onClose(peer) }
  socket.on('close', done)
  socket.on('error', done)
  return peer
}

// ---- the fake host ------------------------------------------------------------

/**
 * Start the demo: project files and agent session files under `root`, and a fake DSH on `port`.
 * @returns {Promise<{ port: number, root: string, transcripts: { claudeDir: string, codexDir: string }, agents: object, spawnAgent: Function, close: () => void }>}
 */
export async function startDemo({ root, port = 0, log = () => {} }) {
  // The demo rewrites its folder on every start: never a folder it did not create.
  const mark = path.join(root, '.dsh-pager-demo')
  if (fs.existsSync(root) && fs.readdirSync(root).length && !fs.existsSync(mark)) throw new Error(`${root} is not empty and not a demo folder; refusing to overwrite it (set DEMO_ROOT)`)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(mark, 'Written by dsh-pager dev.mjs --demo; deleted and rewritten on every start.\n')
  const projects = writeProjects(root)
  const now = Date.now()
  const agentFiles = writeAgentSessions(root, projects, now)

  const workspaces = [
    { workspaceId: 'w-shop', title: 'shop-web', path: projects.shop },
    { workspaceId: 'w-blog', title: 'blog', path: projects.blog },
  ]
  /** sessionId -> { id, w, title, at, running, events, approval?, question?, queue, model, cancel? } */
  const S = new Map()
  for (const s of demoSessions(now)) S.set(s.id, { ...s, running: Boolean(s.running), queue: [], model: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' } })
  const archived = new Set()
  const pending = new Map() // rpcId -> { kind: 'approval' | 'question', sessionId, payload }
  for (const s of S.values()) {
    if (s.approval) pending.set(crypto.randomUUID(), { kind: 'approval', sessionId: s.id, payload: { type: 'approval/requested', sessionId: s.id, ...s.approval } })
    if (s.question) pending.set(crypto.randomUUID(), { kind: 'question', sessionId: s.id, payload: { type: 'question/requested', sessionId: s.id, questions: s.question } })
  }

  const mux = new Set()
  const host = new Set()
  const toMux = (payload, rpcId = crypto.randomUUID()) => { for (const p of mux) p.send({ type: 'server-request', rpcId, payload }) }
  const toHost = (payload) => { for (const p of host) p.send({ type: 'server-request', rpcId: crypto.randomUUID(), payload }) }

  // Live events continue the session's own numbering and go out on the mux as they happen.
  function live(s) {
    return book(0, {
      clock: Date.now,
      onPush: (e) => {
        e.event.seq = s.events.length ? s.events[s.events.length - 1].event.seq + 1 : 1
        s.events.push(e)
        s.at = e.event.time
        toMux({ type: 'session/event', sessionId: s.id, event: e.event, view: e.view })
      },
    })
  }
  function setRunning(s, on) {
    s.running = on
    toHost({ type: 'host/session-status', sessionId: s.id, running: on })
  }
  async function stream(s, L, text, think) {
    if (think) { L.chunk({ type: 'block-start', blockType: 'reasoning' }); await sleep(700) }
    for (let i = 0; i < text.length; ) {
      if (s.cancel) return false
      const n = 2 + Math.floor(Math.random() * 4)
      L.chunk({ type: 'text-delta', text: text.slice(i, i + n) })
      i += n
      await sleep(45)
    }
    L.say(text, think)
    return true
  }
  async function finish(s, L, kind = 'completed') {
    L.end(kind)
    s.cancel = false
    setRunning(s, false)
    const next = s.queue.shift()
    if (next) {
      toMux({ type: 'session/queue', sessionId: s.id, items: s.queue })
      run(s, next.text, next.rpcId).catch((err) => log(`demo turn failed: ${err.message}`))
    }
  }

  /** One demo turn for a message typed on the phone. */
  async function run(s, text, rpcId) {
    const L = live(s)
    setRunning(s, true)
    L.user(text, 0, rpcId)
    L.turn()
    L.step()
    const r = reply(text)
    if (!(await stream(s, L, r.intro, '先弄清楚要做什么，再动手。'))) return finish(s, L, 'cancelled')
    L.chunk({ type: 'tool-call-delta', id: 'live-' + s.events.length, name: r.tool.name })
    await sleep(500)
    const id = 'live-' + crypto.randomBytes(3).toString('hex')
    L.call(id, r.tool.name, r.tool.args, r.tool.view)
    await sleep(1600)
    if (s.cancel) return finish(s, L, 'cancelled')
    L.result(id, '', r.tool.out)
    L.step()
    if (!(await stream(s, L, r.outro))) return finish(s, L, 'cancelled')
    return finish(s, L)
  }

  async function followApproval(s, outcome) {
    const L = live(s)
    const f = FOLLOW_UP.approval[outcome] || FOLLOW_UP.approval.rejected
    const callId = s.approval.callId
    if (f.err) L.result(callId, f.err, null, true)
    else { await sleep(2500); L.result(callId, '', f.out) }
    if (!f.err) L.todos([{ content: '找到订单筛选逻辑', status: 'completed' }, { content: '加导出按钮和 CSV 工具函数', status: 'completed' }, { content: '跑测试', status: 'completed' }, { content: '更新 README', status: 'completed' }])
    L.step()
    await stream(s, L, f.text)
    return finish(s, L)
  }

  async function followQuestion(s, choice) {
    const L = live(s)
    L.step()
    const f = FOLLOW_UP.question(choice)
    await stream(s, L, f.text, '按选定的语气写，控制在 400 字以内。')
    const id = 'live-' + crypto.randomBytes(3).toString('hex')
    L.call(id, 'write', { path: f.file }, { card: 'diff', title: '新建 ' + path.basename(f.file), diffs: [{ path: f.file, oldText: null, newText: f.body }] })
    L.result(id, '已创建')
    return finish(s, L)
  }

  /** Stop a turn: a live one at its next step, a waiting one (approval / question) at once. */
  function cancel(s) {
    for (const [rpcId, p] of pending) {
      if (p.sessionId !== s.id) continue
      pending.delete(rpcId)
      if (p.kind === 'approval') toMux({ type: 'approval/resolved', sessionId: s.id, approvalId: p.payload.approvalId, outcome: 'cancelled' })
      else toMux({ type: 'question/resolved', sessionId: s.id, questionRpcId: rpcId, outcome: 'cancelled' })
      const L = live(s)
      L.end('cancelled')
      setRunning(s, false)
      return
    }
    if (s.running) s.cancel = true
  }

  const listItem = (s) => ({ sessionId: s.id, running: s.running, updatedAt: s.at, origin: 'user', blank: s.events.length === 0, projections: { values: { title: s.title } } })
  const own = (id) => { const s = S.get(id); if (!s) throw Object.assign(new Error('session not found'), { code: 'not-found' }); return s }

  const METHODS = {
    'workspace.list': () => ({
      items: workspaces.map((w) => ({ ...w, sessionIds: [...S.values()].filter((s) => s.w === w.workspaceId).map((s) => s.id) })),
      archivedSessionIds: [...archived],
    }),
    'session.list': () => ({ items: [...S.values()].map(listItem) }),
    'session.history': ({ sessionId, maxMessages = 30, beforeSeq }) => {
      const s = own(sessionId)
      const all = s.events.filter((e) => beforeSeq == null || e.event.seq < beforeSeq)
      // Walk back until maxMessages user/assistant messages are in, like DSH pages by message.
      let i = all.length
      let n = 0
      while (i > 0 && n < maxMessages) { i--; if (/^(user|assistant)\/message$/.test(all[i].event.type)) n++ }
      return { events: all.slice(i), hasMore: i > 0, projections: { values: { title: s.title } } }
    },
    'session.create': ({ workspaceId }) => {
      const id = 'session-' + crypto.randomUUID()
      S.set(id, { id, w: workspaceId, title: '', at: Date.now(), running: false, events: [], queue: [], model: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' } })
      toHost({ type: 'host/session-added', sessionId: id })
      return { sessionId: id }
    },
    'session.prompt': ({ sessionId, content }, rpcId) => {
      const s = own(sessionId)
      const text = (Array.isArray(content) ? content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim()
      if (!text) throw Object.assign(new Error('empty message'), { code: 'bad-request' })
      if (!s.title) {
        s.title = text.split('\n')[0].slice(0, 24)
        setTimeout(() => toMux({ type: 'session/projection', sessionId: s.id, key: 'title', value: s.title }), 1200)
      }
      if (s.running) {
        s.queue.push({ id: 'q-' + crypto.randomBytes(3).toString('hex'), placement: 'next', message: { content: [{ type: 'text', text }] }, text, rpcId })
        toMux({ type: 'session/queue', sessionId: s.id, items: s.queue })
        return { queued: true }
      }
      run(s, text, rpcId).catch((err) => log(`demo turn failed: ${err.message}`))
      return { started: true }
    },
    'session.cancel': ({ sessionId }) => { cancel(own(sessionId)); return {} },
    'session.updateQueue': ({ sessionId, itemId }) => {
      const s = own(sessionId)
      s.queue = s.queue.filter((q) => q.id !== itemId)
      toMux({ type: 'session/queue', sessionId: s.id, items: s.queue })
      return {}
    },
    'session.models': ({ sessionId }) => ({
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [
        { id: 'deepseek-v4', name: 'DeepSeek V4', description: '默认', reasoning: { efforts: [{ id: 'off', name: 'off' }, { id: 'high', name: 'high' }, { id: 'max', name: 'max' }], defaultEffort: 'high' } },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: '更快、更省' },
      ] }],
      current: own(sessionId).model,
    }),
    'session.selectModel': ({ sessionId, provider, model, reasoningEffort }) => {
      const s = own(sessionId)
      s.model = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
      return { selected: s.model }
    },
    'session.rename': ({ sessionId, title }) => {
      const s = own(sessionId)
      s.title = String(title || '').slice(0, 80)
      toMux({ type: 'session/projection', sessionId: s.id, key: 'title', value: s.title })
      return {}
    },
    'session.search': ({ query }) => ({ items: [...S.values()].filter((s) => s.title.includes(String(query || ''))).map(listItem) }),
    'workspace.archiveSession': ({ sessionId }) => { archived.add(sessionId); toHost({ type: 'host/archived-sessions-changed' }); return {} },
  }

  function respond(body) {
    const p = pending.get(body.rpcId)
    if (!p) return
    pending.delete(body.rpcId)
    const s = S.get(p.sessionId)
    const v = (body.result && body.result.value) || {}
    if (p.kind === 'approval') {
      const outcome = body.result && body.result.ok ? v.outcome : 'rejected'
      toMux({ type: 'approval/resolved', sessionId: s.id, approvalId: p.payload.approvalId, outcome })
      followApproval(s, outcome).catch((err) => log(`demo follow-up failed: ${err.message}`))
    } else {
      const a = (v.answer && v.answer.answers && v.answer.answers[0]) || {}
      const choice = (a.selected && a.selected[0]) || a.custom || '你来定'
      toMux({ type: 'question/resolved', sessionId: s.id, questionRpcId: body.rpcId, outcome: body.result && body.result.ok ? 'answered' : 'cancelled' })
      if (body.result && body.result.ok) followQuestion(s, choice).catch((err) => log(`demo follow-up failed: ${err.message}`))
      else { const L = live(s); L.end('cancelled'); setRunning(s, false) }
    }
  }

  const server = http.createServer((req, res) => {
    const reply = (status, obj) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(status, { 'content-type': 'application/json', 'content-length': b.length }); res.end(b) }
    if (req.method !== 'POST' || !(req.url || '').startsWith('/api/')) return reply(404, {})
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return reply(400, {}) }
      if (req.url === '/api/respond') { respond(body); return reply(200, { ok: true }) }
      const method = req.url.slice('/api/'.length)
      const fn = METHODS[method]
      if (!fn) return reply(200, { type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'method-not-found', message: method } } })
      try {
        reply(200, { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: fn(body.payload || {}, body.rpcId) } })
      } catch (err) {
        reply(200, { type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: err.code || 'failed', message: err.message } } })
      }
    })
  })
  server.on('upgrade', (req, socket) => {
    const set = req.url === '/api/events.mux' ? mux : req.url === '/api/events.host' ? host : null
    if (!set) { socket.destroy(); return }
    const peer = acceptSocket(req, socket, (p) => set.delete(p))
    if (!peer) return
    set.add(peer)
    // Like DSH: a new mux connection gets every approval and question still waiting.
    if (set === mux) for (const [rpcId, p] of pending) peer.send({ type: 'server-request', rpcId, payload: p.payload })
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))

  /** Replaces spawn() for "continue from the phone" on the demo's Claude Code / Codex sessions. */
  function spawnAgent(cmd, args) {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const claude = args.includes('--resume')
    const text = claude ? args[args.indexOf('-p') + 1] : args[args.length - 1]
    const file = claude ? path.join(agentFiles.claudeDir, 'demo-shop-web', agentFiles.claude.sid + '.jsonl') : findCodex()
    setTimeout(() => {
      const t = new Date().toISOString()
      const lines = claude
        ? [{ type: 'user', timestamp: t, message: { role: 'user', content: text } }, { type: 'assistant', timestamp: t, message: { id: 'live', role: 'assistant', content: [{ type: 'text', text: '收到。这是演示模式：回复是预设的，不会真的运行 Claude Code。' }] } }]
        : [{ type: 'event_msg', timestamp: t, payload: { type: 'user_message', message: text } }, { type: 'response_item', timestamp: t, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '收到。这是演示模式：回复是预设的，不会真的运行 Codex。' }] } }, { type: 'event_msg', timestamp: t, payload: { type: 'task_complete', duration_ms: 3000 } }]
      fs.appendFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n')
      child.stdout.emit('data', claude ? JSON.stringify({ type: 'result', is_error: false, result: 'ok' }) : '')
      child.emit('exit', 0)
    }, 2500)
    return child
  }
  function findCodex() {
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = walk(p); if (r) return r } else if (f.name.endsWith('.jsonl')) return p } return null }
    return walk(agentFiles.codexDir)
  }

  /**
   * A Claude Code permission request sent through the plugin's real hook endpoint and held
   * there, as tools/pager-hook.mjs would: the phone shows it under Claude Code / Codex.
   * `stateDir` is the plugin's data dir (its hook.json has the URL and token).
   */
  const held = []
  function holdAgentAsk(stateDir) {
    let cfg
    try { cfg = JSON.parse(fs.readFileSync(path.join(stateDir, 'hook.json'), 'utf8')) } catch { return false }
    const body = JSON.stringify({
      session_id: agentFiles.claude.sid, cwd: agentFiles.claude.cwd, hook_event_name: 'PermissionRequest',
      tool_name: 'Bash', tool_input: { command: 'git rm src/store/cart.vuex.js', description: '删除旧的 Vuex 购物车模块' },
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git rm:*' }], behavior: 'allow', destination: 'localSettings' }],
    })
    const req = http.request(`${cfg.url}?src=claude`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pager-token': cfg.token, 'content-length': Buffer.byteLength(body) } }, (res) => res.resume())
    req.on('error', () => {})
    req.end(body)
    held.push(req)
    return true
  }

  log(`demo DSH on 127.0.0.1:${server.address().port}, files under ${root}`)
  return {
    port: server.address().port,
    root,
    transcripts: { claudeDir: agentFiles.claudeDir, codexDir: agentFiles.codexDir },
    spawnAgent,
    holdAgentAsk,
    close() {
      for (const r of held) r.destroy()
      for (const p of [...mux, ...host]) p.close()
      server.close()
    },
  }
}
