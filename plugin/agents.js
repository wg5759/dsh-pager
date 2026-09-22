/**
 * Claude Code and Codex CLI on the same PC, paged through the same phone app
 * as the DSH sessions.
 *
 * Both tools run lifecycle hooks (Claude Code: settings.json `hooks`; Codex:
 * ~/.codex/hooks.json). tools/pager-hook.mjs forwards each hook event to
 * POST /m/api/agents/hook (loopback + token) and prints our answer back.
 *
 *   SessionStart / UserPromptSubmit   remember the session (project, first prompt, turn start)
 *   PermissionRequest                 while the user is away from the PC: hold it, ask the
 *                                     phone, answer allow/deny; otherwise answer nothing so
 *                                     the tool shows its own dialog as usual
 *   Stop                              "done" notice (only while away: at the desk it is noise)
 *   Notification (Claude)             "waiting at the PC" notice for dialogs we did not hold
 *
 * Away (mode "auto"): the PC is locked or has had no keyboard/mouse input for
 * `awayMs`. Mode "phone": always ask the phone first. Mode "pc": never hold.
 * A held request goes back to the PC dialog when nobody answers in `holdMs`,
 * or (auto) as soon as someone touches the PC again.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'

export const SOURCES = { claude: 'Claude Code', codex: 'Codex' }

/**
 * How to launch each CLI without a shell. A native `claude.exe` / `codex` on
 * PATH runs as is; an npm shim (`*.cmd`, which only a shell can run) is
 * replaced by node + the package's JS entry next to it.
 */
export function resolveBins({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix
  const dirs = String(env.PATH || env.Path || '').split(P.delimiter).filter(Boolean)
  const pick = (name, pkgEntry) => {
    for (const dir of dirs) {
      if (platform === 'win32') {
        if (exists(P.join(dir, name + '.exe'))) return [P.join(dir, name + '.exe')]
        const js = P.join(dir, 'node_modules', ...pkgEntry)
        if (exists(P.join(dir, name + '.cmd')) && exists(js)) return [process.execPath, js]
      } else if (exists(P.join(dir, name))) return [P.join(dir, name)]
    }
    return null
  }
  return { claude: pick('claude', ['@anthropic-ai', 'claude-code', 'cli.js']), codex: pick('codex', ['@openai', 'codex', 'bin', 'codex.js']) }
}
// What a Claude Code host (desktop app, IDE, an agent's shell) sets for its child processes to
// tie them to itself: nesting flag, session ids, IPC channel, delegated auth. DSH inherits these
// when an agent started it; a phone-started turn is nobody's child, so they are dropped.
const HOST_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|HOST_SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|SDK_HAS_HOST_AUTH_REFRESH|OAUTH_SCOPES|DESKTOP_APP_VERSION|EXECPATH|SSE_PORT))$/

/** `env` without the variables that tie a process to an enclosing Claude Code session. */
export function hostFreeEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (!HOST_VARS.test(k)) out[k] = v
  return out
}

/** The next step for failures the phone cannot fix itself, or ''. */
export function errorHint(src, msg) {
  msg = String(msg || '')
  if (/\bENOENT\b|is not recognized|command not found/i.test(msg)) return `电脑上找不到 ${SOURCES[src] || src} 命令行：确认已安装，并且在启动 DSH 时的 PATH 里。`
  if (src === 'claude' && /\b401\b|OAuth|authenticat|\/login/i.test(msg)) return '电脑上的 Claude Code 登录已失效：在电脑终端运行 claude，输入 /login 重新登录。'
  if (src === 'codex' && /newer version of Codex|upgrade (to )?(the latest )?codex/i.test(msg)) return '电脑上的 Codex 版本太旧：运行 npm i -g @openai/codex 升级。'
  if (src === 'codex' && /\b401\b|unauthori[sz]ed|not logged in|codex login/i.test(msg)) return '电脑上的 Codex 未登录或登录已失效：在电脑终端运行 codex login。'
  return ''
}

export const MODES = ['auto', 'phone', 'pc']
const DEFAULTS = { mode: 'auto', awayMs: 3 * 60 * 1000, holdMs: 20 * 60 * 1000 }
const MAX_TIMELINE = 200

function clip(s, n) {
  s = String(s == null ? '' : s)
  return s.length > n ? s.slice(0, n) + '…' : s
}
function base(p) {
  const s = String(p || '').replace(/[\\/]+$/, '')
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1) || s
}

/**
 * One line for the approval card and the notification: what the tool is about
 * to do. Claude Code and Codex name tools differently; unknown tools fall back
 * to their JSON input.
 * @returns {{ what: string, detail: string }}
 */
export function describeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {}
  const cmd = Array.isArray(i.command) ? i.command.join(' ') : i.command
  if (typeof cmd === 'string' && cmd) return { what: i.description || i.justification || name || '命令', detail: clip(cmd, 1500) }
  const file = i.file_path || i.path || i.notebook_path
  if (file) return { what: `${name} ${base(file)}`, detail: String(file) }
  if (i.url) return { what: `${name} ${clip(i.url, 80)}`, detail: String(i.url) }
  if (typeof i.patch === 'string' || typeof i.input === 'string') return { what: name || 'apply_patch', detail: clip(i.patch || i.input, 1500) }
  let json = ''
  try { json = JSON.stringify(i, null, 1) } catch {}
  return { what: name || '工具', detail: clip(json === '{}' ? '' : json, 1500) }
}

export class AgentHub extends EventEmitter {
  /**
   * @param {{
   *   notify: { ask(a: object): void, askDone(id: string, outcome: string): void, emit(ev: object): void },
   *   presence?: { get(): { idleMs: number, locked: boolean } | null },
   *   dir?: string, log?: (m: string) => void, now?: () => number,
   * }} opts
   */
  constructor({ notify, presence = { get: () => null }, dir, log = () => {}, now = Date.now, pollMs = 2000 }) {
    super()
    this.notify = notify
    this.presence = presence
    this.dir = dir
    this.log = log
    this.now = now
    this.pollMs = pollMs
    this.sessions = new Map()
    this.pending = new Map()
    this.settings = { ...DEFAULTS, ...this.load() }
  }

  load() {
    if (!this.dir) return {}
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'agents.json'), 'utf8')) } catch { return {} }
  }

  save() {
    if (!this.dir) return
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(path.join(this.dir, 'agents.json'), JSON.stringify(this.settings, null, 1))
  }

  setMode(mode) {
    if (!MODES.includes(mode)) throw Object.assign(new Error('bad mode'), { status: 400, code: 'bad-mode' })
    this.settings.mode = mode
    this.save()
    this.emit('change')
  }

  /** Away from the PC right now? Unknown presence counts as "at the PC" in auto mode. */
  away(s) {
    const { mode, awayMs } = this.settings
    // A turn started from the phone has nobody at the PC to answer its dialogs.
    if (mode === 'phone' || (s && s.phoneTurn)) return true
    if (mode === 'pc') return false
    const p = this.presence.get()
    return Boolean(p && (p.locked || p.idleMs >= awayMs))
  }

  /** Someone is using the PC again (fresh input within 5 s, unlocked). */
  back() {
    if (this.settings.mode !== 'auto') return false
    const p = this.presence.get()
    return Boolean(p && !p.locked && p.idleMs < 5000)
  }

  key(src, sid) { return `agent:${src}:${sid}` }

  session(src, ev) {
    const key = this.key(src, ev.session_id)
    let s = this.sessions.get(key)
    if (!s) {
      s = { key, src, sid: ev.session_id, cwd: '', title: '', transcript: '', running: false, turnStart: 0, at: this.now(), timeline: [], seq: 0 }
      this.sessions.set(key, s)
    }
    if (ev.cwd) s.cwd = ev.cwd
    if (ev.transcript_path) s.transcript = ev.transcript_path
    s.at = this.now()
    return s
  }

  label(s) { return `${SOURCES[s.src] || s.src} · ${base(s.cwd) || '项目'}` }

  push(s, item) {
    item.seq = ++s.seq
    item.time = this.now()
    s.timeline.push(item)
    if (s.timeline.length > MAX_TIMELINE) s.timeline.shift()
  }

  /**
   * One hook event. Resolves with the JSON the hook prints back to the tool
   * ({} = no opinion, the tool carries on as it would without us).
   */
  async handle(src, ev, { signal } = {}) {
    if (!SOURCES[src] || !ev || typeof ev.session_id !== 'string' || !ev.session_id) return {}
    const s = this.session(src, ev)
    switch (ev.hook_event_name) {
      case 'SessionStart':
        this.emit('change')
        return {}
      case 'UserPromptSubmit': {
        const text = String(ev.prompt || '')
        if (!s.title && text.trim()) s.title = clip(text.trim().split('\n')[0], 60)
        s.running = true
        s.turnStart = this.now()
        this.push(s, { k: 'u', text: clip(text, 4000) })
        this.emit('change')
        return {}
      }
      case 'PermissionRequest':
        return this.permission(s, ev, signal)
      case 'Notification': {
        // A dialog we did not hold (user was at the PC, or mode pc) has now waited unanswered.
        if (ev.notification_type === 'permission_prompt' && this.away(s)) {
          this.notify.emit({ t: 'info', s: s.key, title: this.label(s), text: clip(ev.message || '在电脑上等你确认', 200) })
        }
        return {}
      }
      case 'Stop': {
        const ms = s.turnStart ? this.now() - s.turnStart : undefined
        s.running = false
        s.turnStart = 0
        const text = typeof ev.last_assistant_message === 'string' ? ev.last_assistant_message : ''
        if (text) this.push(s, { k: 'a', text: clip(text, 20000) })
        this.push(s, { k: 'end', reason: 'completed', ms })
        if (this.away(s)) this.notify.emit({ t: 'done', s: s.key, title: this.label(s), ms, preview: clip(text.replace(/\s+/g, ' '), 140) })
        this.emit('change')
        return {}
      }
      case 'SessionEnd':
        s.running = false
        this.emit('change')
        return {}
      default:
        return {}
    }
  }

  permission(s, ev, signal) {
    const { what, detail } = describeTool(ev.tool_name, ev.tool_input)
    const row = { k: 't', id: 'p' + (s.seq + 1), name: ev.tool_name, kind: 'other', title: clip(what, 160), detail: clip(detail, 1500) }
    this.push(s, row)
    if (!this.away(s)) { row.done = true; row.out = '在电脑上确认'; this.emit('change'); return {} }
    const id = crypto.randomUUID()
    const suggestions = Array.isArray(ev.permission_suggestions) ? ev.permission_suggestions : []
    const ask = { id, rpc: 'agent:' + id, s: s.key, src: s.src, tool: ev.tool_name, what: row.title, detail: row.detail, title: this.label(s), remember: s.src === 'claude' && suggestions.length > 0, at: this.now() }
    return new Promise((resolve) => {
      const p = { ask, row, suggestions, resolve, timer: null, poll: null }
      this.pending.set(id, p)
      p.timer = setTimeout(() => this.settle(id, 'timeout'), this.settings.holdMs)
      // Held while away; the moment someone uses the PC again, hand it back to the PC dialog.
      p.poll = setInterval(() => { if (this.back()) this.settle(id, 'local') }, this.pollMs)
      if (p.timer.unref) p.timer.unref()
      if (p.poll.unref) p.poll.unref()
      // The tool gave up on the hook (its timeout, Esc at the PC): withdraw the phone's card.
      if (signal) signal.addEventListener('abort', () => this.settle(id, 'gone'), { once: true })
      this.notify.ask(ask)
      this.emit('ask', ask)
      this.emit('change')
    })
  }

  /** The phone's answer; `remember` (Claude Code only) also adds this session's suggested allow rules. */
  decide(id, outcome, { remember = false } = {}) {
    const p = this.pending.get(id)
    if (!p) return { accepted: false, reason: 'not-pending' }
    if (outcome !== 'allowed-once' && outcome !== 'rejected') return { accepted: false, reason: 'bad-outcome' }
    this.settle(id, outcome, remember)
    return { accepted: true }
  }

  settle(id, outcome, remember) {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    clearInterval(p.poll)
    let answer = {}
    if (outcome === 'allowed-once') {
      const decision = { behavior: 'allow' }
      if (remember && p.suggestions.length) decision.updatedPermissions = p.suggestions.map((x) => ({ ...x, destination: 'session' }))
      answer = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
      p.row.done = true
      p.row.out = remember ? '手机上允许（本次会话记住）' : '手机上允许'
    } else if (outcome === 'rejected') {
      answer = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'The user denied this from their phone.' } } }
      p.row.done = true
      p.row.err = true
      p.row.out = '手机上拒绝'
    } else {
      p.row.done = true
      p.row.out = { local: '回到电脑，交给电脑确认', timeout: '手机没回应，交给电脑确认', gone: '电脑上已处理或已取消' }[outcome] || outcome
    }
    this.notify.askDone(id, outcome)
    this.emit('askDone', { id, s: p.ask.s, outcome })
    this.emit('change')
    p.resolve(answer)
  }

  /**
   * Continue a session from the phone: `claude -p <text> --resume <id>` /
   * `codex exec resume <id> <text>` in the session's folder. The session file
   * grows as it runs (the phone view refreshes from it); its dialogs go to the
   * phone; a failed run comes back as an error notice with the tool's own words.
   * @param {{ key: string, src: string, sid: string, cwd: string }} target
   * @param {(cmd: string, args: string[], opts: object) => import('node:child_process').ChildProcess} spawnImpl
   */
  prompt(target, text, { spawnImpl, bins = {}, env = process.env }) {
    text = String(text || '').trim()
    if (!text) throw Object.assign(new Error('消息是空的'), { status: 400, code: 'empty' })
    if (!target.cwd) throw Object.assign(new Error('不知道这个会话的项目目录'), { status: 400, code: 'no-cwd' })
    const s = this.session(target.src, { session_id: target.sid, cwd: target.cwd })
    if (s.running) throw Object.assign(new Error('这个会话正在运行，等它结束再发'), { status: 409, code: 'busy' })
    const args = target.src === 'claude'
      ? ['-p', text, '--resume', target.sid, '--output-format', 'json']
      : ['exec', 'resume', target.sid, text]
    // bins[src] = [command, ...leading args]; never a shell: the text must not be parsed by cmd.exe.
    const [cmd, ...pre] = bins[target.src] || [target.src === 'claude' ? 'claude' : 'codex']
    const child = spawnImpl(cmd, [...pre, ...args], { cwd: target.cwd, env: hostFreeEnv(env), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    s.running = true
    s.phoneTurn = true
    s.turnStart = this.now()
    let out = ''
    const keep = (d) => { out = (out + d).slice(-8000) }
    if (child.stdout) child.stdout.on('data', keep)
    if (child.stderr) child.stderr.on('data', keep)
    const finish = (code) => {
      if (!s.phoneTurn) return
      s.phoneTurn = false
      s.running = false
      let msg = ''
      if (target.src === 'claude') { try { const j = JSON.parse(out.slice(out.indexOf('{'))); if (j.is_error) msg = j.result || 'error' } catch {} }
      if (code !== 0 && !msg) msg = out.trim().split('\n').slice(-3).join(' ') || `exit ${code}`
      const hint = msg && errorHint(target.src, msg)
      if (hint) msg = `${hint}\n原话：${msg}`
      if (msg) {
        this.notify.emit({ t: 'err', s: s.key, title: this.label(s), msg: clip(msg, 300) })
        this.emit('fail', { s: s.key, msg: clip(msg, 300) })
      }
      this.emit('change')
    }
    child.on('exit', finish)
    child.on('error', (err) => { out += String(err && err.message); finish(-1) })
    this.push(s, { k: 'u', text: clip(text, 4000), phone: true })
    this.emit('change')
    return { started: true }
  }

  /** Pending approvals, as ask frames (phone reconnects get them again). */
  asks() { return [...this.pending.values()].map((p) => p.ask) }

  /** Sessions with activity in the last `days` days, newest first. */
  list(days = 7) {
    const since = this.now() - days * 864e5
    return [...this.sessions.values()].filter((s) => s.at >= since || s.running).sort((a, b) => b.at - a.at).map((s) => ({
      id: s.key, src: s.src, name: SOURCES[s.src], project: base(s.cwd), cwd: s.cwd, title: s.title, at: s.at, run: s.running,
      asks: [...this.pending.values()].filter((p) => p.ask.s === s.key).length,
    }))
  }

  get(key) { return this.sessions.get(key) || null }

  close() {
    for (const id of [...this.pending.keys()]) this.settle(id, 'local')
  }
}
