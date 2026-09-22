/**
 * dsh-mobile HTTP surface, mounted at /m on the DSH web server.
 *
 *   GET  /m/                 phone app shell (index.html with CSS/JS inlined)
 *   GET  /m/<asset>          other files under www/
 *   GET  /m/api/boot         workspaces + compact session list (one round trip)
 *   GET  /m/api/history      folded history page (see fold.js; ~1% of raw size)
 *   GET  /m/api/events       SSE: compact live frames bridged from DSH's two
 *                            WebSocket downlinks, text deltas coalesced
 *   GET  /m/api/img          one session image attachment, immutable-cached
 *   GET  /m/api/call         one tool call unclipped (?s=&id=&seq=&rseq=)
 *   GET  /m/api/fs           a directory listing or a file's text, inside the
 *                            session's workspace only (?s=&path=; see files.js)
 *   GET  /m/api/raw          an image / video / audio file of that workspace,
 *                            with Range support
 *   POST /m/api/rpc          allowlisted DSH unary call {method, payload}
 *   POST /m/api/respond      approval / question answer {rpcId, result}
 *   GET  /m/api/push/key     Web Push: this server's public key + device count
 *   POST /m/api/push/subscribe | unsubscribe | test
 *                            register the installed web app (iPhone) for the
 *                            same notices the Android app gets (see push.js)
 *   POST /m/api/agents/hook  Claude Code / Codex hook events (tools/pager-hook.mjs;
 *                            token from ~/.dsh-pager/hook.json; see agents.js)
 *   GET  /m/api/agents       their recent sessions (hooks + session files of the last
 *                            7 days), pending approvals, routing mode
 *   GET  /m/api/agents/history   one session as chat items, folded from its session
 *                            file (transcripts.js), which is then watched for changes
 *   POST /m/api/agents/prompt    continue a session from the phone {s, text}
 *   POST /m/api/agents/mode  auto | phone | pc
 *   GET  /m/api/app/latest   the Android app build this PC offers (version, SHA-256),
 *   GET  /m/api/app/apk      and the APK itself: the app updates itself from here
 *
 * This module talks to DSH only through its public loopback wire protocol
 * (POST /api/<method>, WS /api/events.mux|host), exactly like DSH's own web
 * client. It never imports DSH internals, so it runs unchanged both inside the
 * DSH process (index.js) and as a standalone dev server (dev.mjs).
 *
 * Trust: /m/api/* applies the same DNS-rebinding / cross-site fence DSH uses
 * for /api (loopback or `trustedHosts` Host, same-origin Origin, no cross-site
 * Fetch metadata). It is not authentication: remote access must come through
 * a VPN or an authenticating gateway (see docs/remote-access.md).
 *
 * Log lines are ASCII on purpose: DSH's stdout is appended by PowerShell,
 * which mangles mixed encodings.
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { foldHistory, foldUser, foldAssistant, foldCall, foldResult, foldQueue, fullCall, resultCallId } from './fold.js'
import { NotifyHub } from './notify.js'
import { confine, describe as describeFile, parseRange, MEDIA } from './files.js'
import { WebPush, noticePayload, defaultDir } from './push.js'
import { spawn } from 'node:child_process'
import { AgentHub, SOURCES, resolveBins } from './agents.js'
import { createPresence } from './presence.js'
import { foldFile, recentFiles, headMeta } from './transcripts.js'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const WWW = path.join(PLUGIN_DIR, 'www')

/** The only DSH methods a phone may invoke through /m/api/rpc. */
const RPC_ALLOW = new Set([
  'session.create', 'session.prompt', 'session.cancel', 'session.models', 'session.selectModel',
  'session.rename', 'session.search', 'session.updateQueue', 'workspace.archiveSession',
])

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Canonical form of one `trustedHosts` entry, or null when it is not a bare
 * `host` / `host:port` authority. Mirrors DSH's assertTrustedAuthority: an
 * entry that URL parsing would silently rewrite (`user@host`, `host/path`, a
 * dangling colon, a zero-padded port, unbracketed IPv6) is a typo that would
 * change what it grants, so it is refused. `:80` and `:443` count as explicit.
 * @param {unknown} entry
 */
export function canonicalTrustedHost(entry) {
  if (typeof entry !== 'string') return null
  let url
  try { url = new URL(`http://${entry}`) } catch { return null }
  const port = url.port !== '' ? url.port : new URL(`https://${entry}`).port
  const canon = port === '' ? url.hostname : `${url.hostname}:${port}`
  return canon === entry.toLowerCase() ? canon : null
}

/**
 * Same fence as DSH's isTrustedApiRequest: the Host must be loopback or one of
 * the deployment's `trustedHosts` (exact `host:port`, or a port-less `host`
 * matching any port), and any browser Origin must be same-host.
 * @param {import('node:http').IncomingMessage} req
 * @param {string[]} [trustedHosts]
 */
export function trusted(req, trustedHosts = []) {
  const host = req.headers.host
  if (!host) return false
  let hostUrl
  try { hostUrl = new URL(`http://${host}`) } catch { return false }
  const listed = trustedHosts.some((entry) => {
    const canon = canonicalTrustedHost(entry)
    if (canon === null) return false
    const e = new URL(`http://${canon}`)
    return canon === e.hostname ? e.hostname === hostUrl.hostname : e.host === hostUrl.host
  })
  if (!LOOPBACK.has(hostUrl.hostname) && !listed) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function acceptsGzip(req) {
  return /\bgzip\b/.test(req.headers['accept-encoding'] || '')
}

function json(req, res, status, obj) {
  let body = Buffer.from(JSON.stringify(obj))
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  if (body.length > 1024 && acceptsGzip(req)) {
    body = zlib.gzipSync(body, { level: 6 })
    headers['content-encoding'] = 'gzip'
    headers.vary = 'accept-encoding'
  }
  headers['content-length'] = body.length
  res.writeHead(status, headers)
  res.end(body)
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(Object.assign(new Error('bad json'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

/**
 * @param {{ apiPort: () => number, servePort?: () => number, log?: (msg: string) => void, trustedHosts?: string[], pushDir?: string, appApk?: string, transcripts?: { claudeDir?: string, codexDir?: string }, spawnAgent?: typeof spawn }} opts
 *   servePort: where /m itself is served, when that is not DSH's port (dev.mjs); hooks post there.
 *   appApk: the APK offered for in-app updates (build.sh writes <apk>.json beside it); default
 *   android/out/DSH.apk, then the newest android/out/dsh-pager-v*.apk of this repo.
 *   transcripts / spawnAgent: where Claude Code / Codex session files live and how a phone turn
 *   starts one of them; only the demo (demo/fake-dsh.mjs) replaces the real ones.
 * @returns {{ handle: (req, res) => Promise<void>, close: () => void }}
 */
export function createMobile({ apiPort, servePort = apiPort, log = () => {}, trustedHosts = [], pushDir, appApk, transcripts = {}, spawnAgent = spawn }) {
  // Fail the load loudly, as DSH does, rather than 403 every phone request later.
  const badHost = trustedHosts.find((h) => canonicalTrustedHost(h) === null)
  if (badHost !== undefined) throw new Error(`dsh-pager: trustedHosts entry ${JSON.stringify(badHost)} is not a bare host[:port] authority`)
  const bridges = new Set()
  let shell = null

  const base = () => `http://127.0.0.1:${apiPort()}`

  // Always-on watcher behind /m/api/notify. Started shortly after load (DSH may
  // still be binding its port) so notices are buffered even before a phone connects.
  const hub = new NotifyHub({ wsBase: () => `ws://127.0.0.1:${apiPort()}`, listSessions: () => value('session.list', {}), log })
  const hubTimer = setTimeout(() => hub.start(), 3000)

  // Installed web apps (iPhone) get the same notices through Web Push.
  const dataDir = pushDir || defaultDir()
  const push = new WebPush({ dir: dataDir, log })
  hub.onNotice((ev) => {
    const n = noticePayload(ev)
    if (n && push.list().length) push.broadcast(n.payload, n).catch((err) => log(`push failed: ${err && err.message}`))
  })

  // Claude Code / Codex on this PC: their hooks post here (see agents.js).
  const presence = createPresence({ log })
  const agents = new AgentHub({
    notify: { ask: (a) => hub.externalAsk(a), askDone: (id, o) => hub.externalAskDone(id, o), emit: (ev) => hub.emit(ev) },
    presence, dir: dataDir, log,
  })
  // tools/pager-hook.mjs reads where to post and the shared token from here.
  let hookToken = ''
  function writeHookConfig() {
    const file = path.join(dataDir, 'hook.json')
    try { hookToken = JSON.parse(fs.readFileSync(file, 'utf8')).token || '' } catch {}
    if (!/^[0-9a-f]{64}$/.test(hookToken)) hookToken = crypto.randomBytes(32).toString('hex')
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${servePort()}/m/api/agents/hook`, token: hookToken }, null, 1), { mode: 0o600 })
    } catch (err) { log(`agents: cannot write hook.json: ${err.message}`) }
  }
  const hookTimer = setTimeout(writeHookConfig, 3000)

  // Sessions found on disk (before the hooks were installed, or after a restart
  // emptied the hub). Rescanned at most every 15 s; each file refolded only when it changed.
  const diskMeta = new Map()
  let diskList = null
  const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''
  function diskSessions() {
    if (diskList && Date.now() - diskList.at < 15000) return diskList.v
    const v = recentFiles({ days: 7, max: 30, ...transcripts }).map((f) => {
      let m = diskMeta.get(f.file)
      if (!m || m.size !== f.size || m.mtime !== f.at) {
        m = { size: f.size, mtime: f.at, title: '', cwd: '' }
        // Folder and first prompt from the head; Claude Code's own titles are rewritten near the end.
        try { const h = headMeta(f.file, f.src); m.cwd = h.cwd; m.title = h.title } catch {}
        if (f.src === 'claude') { try { const x = foldFile(f.file, f.src, 256 * 1024); m.title = x.title || m.title; m.cwd = m.cwd || x.cwd } catch {} }
        diskMeta.set(f.file, m)
      }
      return { id: `agent:${f.src}:${f.id}`, src: f.src, sid: f.id, name: SOURCES[f.src], project: baseName(m.cwd), cwd: m.cwd, title: m.title, at: f.at, run: false, asks: 0, file: f.file }
    })
    diskList = { at: Date.now(), v }
    return v
  }
  /** Everything known about one agent session: hub state first, disk as fallback. */
  function agentInfo(key) {
    const live = agents.get(key)
    const disk = diskSessions().find((x) => x.id === key)
    if (!live && !disk) return null
    const [, src, sid] = /^agent:([a-z]+):(.+)$/.exec(key) || []
    return { key, src, sid, cwd: (live && live.cwd) || (disk && disk.cwd) || '', file: (live && live.transcript) || (disk && disk.file) || '', title: (live && live.title) || (disk && disk.title) || '' }
  }
  function agentSessions() {
    const disk = new Map(diskSessions().map((x) => [x.id, x]))
    // A session the hooks only saw ask for permission (e.g. after a restart) has no title yet; its file does.
    const live = agents.list().map((x) => { const d = disk.get(x.id); return d ? { ...x, title: x.title || d.title, cwd: x.cwd || d.cwd, project: x.project || d.project } : x })
    const seen = new Set(live.map((x) => x.id))
    return live.concat([...disk.values()].filter((x) => !seen.has(x.id)).map(({ file, sid, ...x }) => x)).sort((a, b) => b.at - a.at).slice(0, 30)
  }
  // Session files a phone is looking at: a change means "refetch" (debounced), for 10 minutes after the last look.
  const watched = new Map()
  function watchFile(file) {
    const w = watched.get(file)
    if (w) { w.until = Date.now() + 600000; return }
    if (watched.size >= 8) {
      const oldest = [...watched.entries()].sort((a, b) => a[1].until - b[1].until)[0]
      oldest[1].w.close()
      watched.delete(oldest[0])
    }
    let t = null
    try {
      const fw = fs.watch(file, () => { clearTimeout(t); t = setTimeout(() => agents.emit('change'), 1500) })
      fw.on('error', () => { fw.close(); watched.delete(file) })
      watched.set(file, { w: fw, until: Date.now() + 600000 })
    } catch {}
  }
  const watchSweep = setInterval(() => { for (const [f, w] of watched) if (w.until < Date.now()) { w.w.close(); watched.delete(f) } }, 60000)
  watchSweep.unref()
  const bins = resolveBins()
  function hookCaller(req) {
    const got = Buffer.from(String(req.headers['x-pager-token'] || ''))
    const want = Buffer.from(hookToken)
    // Relayed phone traffic also arrives from 127.0.0.1: the token is the gate, and browsers (Origin) never are callers.
    return want.length === 64 && got.length === want.length && crypto.timingSafeEqual(got, want) && !req.headers.origin
  }

  async function dsh(method, payload, timeoutMs = 30000, rpcId = crypto.randomUUID()) {
    const res = await fetch(`${base()}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw Object.assign(new Error(`DSH ${method} HTTP ${res.status}`), { status: 502, code: `http-${res.status}` })
    return (await res.json()).result
  }

  async function value(method, payload, timeoutMs) {
    const r = await dsh(method, payload, timeoutMs)
    if (!r || !r.ok) throw Object.assign(new Error((r && r.error && r.error.message) || `${method} failed`), { status: 502, code: r && r.error && r.error.code })
    return r.value
  }

  // ---- static -------------------------------------------------------------

  /** index.html with app.css/app.js inlined; rebuilt only when a file changes. */
  function buildShell() {
    const files = ['index.html', 'app.css', 'app.js'].map((f) => path.join(WWW, f))
    const key = files.map((f) => { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}` }).join('|')
    if (shell && shell.key === key) return shell
    const [html, css, js] = files.map((f) => fs.readFileSync(f, 'utf8'))
    const jsHash = crypto.createHash('sha256').update(js).digest('base64')
    // Replacement functions, not strings: app.js contains `$` sequences that
    // String.replace would otherwise interpret as substitution patterns.
    const out = html.replace('<!--CSS-->', () => `<style>${css}</style>`).replace('<!--JS-->', () => `<script>${js}</script>`)
    const raw = Buffer.from(out)
    shell = {
      key,
      raw,
      gz: zlib.gzipSync(raw, { level: 9 }),
      etag: `"${crypto.createHash('sha1').update(raw).digest('base64url')}"`,
      csp: `default-src 'self'; script-src 'sha256-${jsHash}'; worker-src 'self'; manifest-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    }
    return shell
  }

  function serveShell(req, res) {
    const s = buildShell()
    const headers = { etag: s.etag, 'cache-control': 'no-cache', 'content-security-policy': s.csp, vary: 'accept-encoding', 'referrer-policy': 'no-referrer' }
    if (req.headers['if-none-match'] === s.etag) { res.writeHead(304, headers); res.end(); return }
    const gz = acceptsGzip(req)
    const body = gz ? s.gz : s.raw
    res.writeHead(200, { ...headers, 'content-type': MIME['.html'], 'content-length': body.length, ...(gz ? { 'content-encoding': 'gzip' } : {}) })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  function serveAsset(rel, req, res) {
    const file = path.resolve(WWW, rel)
    const type = MIME[path.extname(file).toLowerCase()]
    if (!file.startsWith(WWW + path.sep) || !type || /(^|[\\/])app\.(js|css)$/.test(rel)) { res.writeHead(404); res.end(); return }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end(); return }
      // The service worker and manifest must update with the plugin, not a day later.
      const fresh = /^(sw\.js|manifest\.webmanifest)$/.test(rel)
      res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'cache-control': fresh ? 'no-cache' : 'public, max-age=86400' })
      res.end(buf)
    })
  }

  // ---- api ----------------------------------------------------------------

  async function boot() {
    const [ws, sl] = await Promise.all([value('workspace.list', {}), value('session.list', {})])
    const archived = new Set(ws.archivedSessionIds || [])
    const owner = new Map()
    for (const w of ws.items) for (const id of w.sessionIds) owner.set(id, w.workspaceId)
    const sessions = []
    const blanks = {}
    for (const s of sl.items) {
      if (s.origin === 'subagent' || archived.has(s.sessionId)) continue
      const w = owner.get(s.sessionId) || null
      if (s.blank) { if (w && !blanks[w] && !s.running) blanks[w] = s.sessionId; continue }
      const v = (s.projections && s.projections.values) || {}
      sessions.push({ id: s.sessionId, title: typeof v.title === 'string' ? v.title : '', at: s.updatedAt, run: s.running, w })
    }
    return {
      workspaces: ws.items.map((w) => ({ id: w.workspaceId, title: w.title, path: w.path })),
      sessions,
      blanks,
    }
  }

  async function history(url) {
    const sessionId = url.searchParams.get('s')
    if (!sessionId) throw Object.assign(new Error('missing s'), { status: 400, code: 'bad-request' })
    const before = url.searchParams.get('before')
    const n = Math.min(100, Math.max(1, Number(url.searchParams.get('n')) || 30))
    const payload = { sessionId, maxMessages: n }
    if (before !== null && before !== '') payload.beforeSeq = Number(before)
    const v = await value('session.history', payload, 90000)
    const f = foldHistory(v.events)
    const pv = (v.projections && v.projections.values) || {}
    return { ...f, hasMore: Boolean(v.hasMore), title: f.title || (typeof pv.title === 'string' ? pv.title : undefined) }
  }

  // ---- app self-update -------------------------------------------------------

  /** The APK to offer and its build.sh metadata, or null when there is none. */
  function appBuild() {
    let files = appApk ? [appApk] : []
    if (!appApk) {
      const out = path.join(PLUGIN_DIR, '..', 'android', 'out')
      let pub = []
      try { pub = fs.readdirSync(out).filter((f) => /^dsh-pager-v[\d.]+\.apk$/.test(f)).map((f) => path.join(out, f)) } catch {}
      files = [path.join(out, 'DSH.apk'), ...pub.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)]
    }
    for (const f of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(f + '.json', 'utf8'))
        if (Number.isInteger(meta.versionCode) && /^[0-9a-f]{64}$/.test(meta.sha256)) return { file: f, ...meta }
      } catch {}
    }
    return null
  }

  // ---- result viewer --------------------------------------------------------

  let wsCache = null
  async function rootOf(sessionId) {
    if (!sessionId) throw Object.assign(new Error('missing s'), { status: 400, code: 'bad-request' })
    if (sessionId.startsWith('agent:')) {
      const s = agentInfo(sessionId)
      if (!s || !s.cwd) throw Object.assign(new Error('不知道这个会话的项目目录'), { status: 404, code: 'no-workspace' })
      return s.cwd
    }
    if (!wsCache || Date.now() - wsCache.at > 10000) wsCache = { at: Date.now(), v: await value('workspace.list', {}) }
    const w = wsCache.v.items.find((x) => (x.sessionIds || []).includes(sessionId))
    if (!w || !w.path) throw Object.assign(new Error('这个对话不属于任何工作区，没有可查看的文件'), { status: 404, code: 'no-workspace' })
    return w.path
  }

  /** One tool call with its full input, diff and output: the page ending at its result holds both. */
  async function callDetail(url) {
    const sessionId = url.searchParams.get('s')
    const id = url.searchParams.get('id')
    const seq = Number(url.searchParams.get('seq'))
    const rseqRaw = url.searchParams.get('rseq')
    const rseq = rseqRaw ? Number(rseqRaw) : NaN
    if (!sessionId || !id || !Number.isFinite(seq)) throw Object.assign(new Error('missing s/id/seq'), { status: 400, code: 'bad-request' })
    const end = Number.isFinite(rseq) && rseq > seq ? rseq : seq
    for (const maxMessages of [1, 4]) {
      const v = await value('session.history', { sessionId, maxMessages, beforeSeq: end + 1 }, 90000)
      let call = null
      let result = null
      for (const entry of v.events) {
        const e = entry && entry.event
        if (!e) continue
        if (e.type === 'tool/call' && e.data && e.data.callId === id) call = entry
        else if (e.type === 'tool/result' && resultCallId(e) === id) result = entry
      }
      if (call) return fullCall(call, result)
    }
    throw Object.assign(new Error('找不到这次操作的记录'), { status: 404, code: 'not-found' })
  }

  async function raw(url, req, res) {
    const { real, stat } = await confine(await rootOf(url.searchParams.get('s')), url.searchParams.get('path'))
    const type = MEDIA[path.extname(real).toLowerCase()]
    if (!stat.isFile() || !type) throw Object.assign(new Error('这种文件不能直接打开'), { status: 415, code: 'unsupported' })
    const headers = {
      'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, no-cache',
      'x-content-type-options': 'nosniff',
      // An SVG opened directly must not run script.
      'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(real))}`,
    }
    const range = parseRange(req.headers.range, stat.size)
    if (range === false) { res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` }); res.end(); return }
    const { start, end } = range || { start: 0, end: stat.size - 1 }
    const length = stat.size ? end - start + 1 : 0
    res.writeHead(range ? 206 : 200, { ...headers, 'content-length': length, ...(range ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}) })
    if (req.method === 'HEAD' || !length) { res.end(); return }
    const stream = fs.createReadStream(real, { start, end })
    stream.on('error', () => res.destroy())
    req.on('close', () => stream.destroy())
    stream.pipe(res)
  }

  async function image(url, req, res) {
    const v = await value('session.attachment', { sessionId: url.searchParams.get('s'), attachmentId: url.searchParams.get('id') }, 60000)
    const buf = Buffer.from(v.data, 'base64')
    res.writeHead(200, { 'content-type': v.attachment.mediaType, 'content-length': buf.length, 'cache-control': 'private, max-age=31536000, immutable' })
    res.end(buf)
  }

  async function respond(body) {
    if (typeof body.rpcId !== 'string' || !body.result || typeof body.result.ok !== 'boolean') throw Object.assign(new Error('bad respond body'), { status: 400 })
    const res = await fetch(`${base()}/api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId: body.rpcId, result: body.result }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) throw Object.assign(new Error(`respond HTTP ${res.status}`), { status: 502 })
    return res.json()
  }

  async function api(route, url, req, res) {
    const isPost = req.method === 'POST'
    if (isPost && !/^application\/json\b/.test(req.headers['content-type'] || '')) return json(req, res, 415, { ok: false, error: { code: 'bad-content-type', message: 'application/json required' } })
    try {
      if (route === 'ping' && !isPost) return json(req, res, 200, { ok: true, t: Date.now() })
      if (route === 'boot' && !isPost) return json(req, res, 200, { ok: true, value: await boot() })
      if (route === 'history' && !isPost) return json(req, res, 200, { ok: true, value: await history(url) })
      if (route === 'img' && !isPost) return await image(url, req, res)
      if (route === 'call' && !isPost) return json(req, res, 200, { ok: true, value: await callDetail(url) })
      if (route === 'fs' && !isPost) return json(req, res, 200, { ok: true, value: await describeFile(await rootOf(url.searchParams.get('s')), url.searchParams.get('path')) })
      if (route === 'raw' && !isPost) return await raw(url, req, res)
      if (route === 'events' && !isPost) return events(req, res)
      if (route === 'notify' && !isPost) {
        const since = url.searchParams.get('since')
        return hub.subscribe(req, res, { since: since === null ? undefined : Number(since), epoch: url.searchParams.get('epoch') || undefined, hb: Number(url.searchParams.get('hb')) || 120 })
      }
      if (route === 'rpc' && isPost) {
        const body = await readJson(req, 48 * 1024 * 1024)
        if (!RPC_ALLOW.has(body.method)) return json(req, res, 400, { ok: false, error: { code: 'method-not-allowed', message: String(body.method) } })
        // A caller-minted rpcId comes back as user/message source.rpcId, which is
        // how the phone reconciles its optimistic "sending" bubble.
        const rpcId = typeof body.rpcId === 'string' && UUID.test(body.rpcId) ? body.rpcId : undefined
        if (body.method === 'session.prompt' && body.payload) hub.markPhone(body.payload.sessionId)
        return json(req, res, 200, await dsh(body.method, body.payload || {}, body.method === 'session.prompt' ? 180000 : 45000, rpcId))
      }
      if (route === 'respond' && isPost) {
        const body = await readJson(req, 1024 * 1024)
        if (typeof body.rpcId === 'string' && body.rpcId.startsWith('agent:')) {
          const v = (body.result && body.result.value) || {}
          return json(req, res, 200, { ok: true, value: agents.decide(v.approvalId || body.rpcId.slice(6), v.outcome, { remember: Boolean(v.remember) }) })
        }
        return json(req, res, 200, { ok: true, value: await respond(body) })
      }
      if (route === 'agents/hook' && isPost) {
        if (!hookCaller(req)) return json(req, res, 403, { ok: false, error: { code: 'forbidden', message: 'bad hook token' } })
        const ev = await readJson(req, 16 * 1024 * 1024)
        // A held PermissionRequest answers when the phone does; the tool closing the hook cancels it.
        req.socket.setTimeout(0)
        const ac = new AbortController()
        res.on('close', () => { if (!res.writableEnded) ac.abort() })
        const answer = await agents.handle(url.searchParams.get('src'), ev, { signal: ac.signal })
        if (!res.destroyed) json(req, res, 200, answer)
        return
      }
      if (route === 'agents' && !isPost) {
        const pc = presence.get()
        return json(req, res, 200, { ok: true, value: { mode: agents.settings.mode, away: agents.away(), pc: pc && { idleMs: pc.idleMs, locked: pc.locked }, sessions: agentSessions(), asks: agents.asks() } })
      }
      if (route === 'agents/history' && !isPost) {
        const key = url.searchParams.get('s') || ''
        const info = agentInfo(key)
        if (!info) throw Object.assign(new Error('找不到这个会话'), { status: 404, code: 'not-found' })
        let items
        let title = info.title
        let truncated = false
        if (info.file) {
          const f = foldFile(info.file, info.src)
          items = f.items
          title = f.title || title
          truncated = f.truncated
          watchFile(info.file)
        } else items = (agents.get(key) || { timeline: [] }).timeline.map((it) => ({ ...it }))
        return json(req, res, 200, { ok: true, value: { items, partial: null, firstSeq: items.length ? items[0].seq : -1, lastSeq: items.length ? items[items.length - 1].seq : -1, hasMore: false, truncated, title } })
      }
      if (route === 'agents/prompt' && isPost) {
        const b = await readJson(req, 64 * 1024)
        const info = agentInfo(b.s || '')
        if (!info) throw Object.assign(new Error('找不到这个会话'), { status: 404, code: 'not-found' })
        return json(req, res, 200, { ok: true, value: agents.prompt(info, b.text, { spawnImpl: spawnAgent, bins }) })
      }
      if ((route === 'app/latest' || route === 'app/apk') && !isPost) {
        const b = appBuild()
        if (!b) throw Object.assign(new Error('这台电脑上没有可用的 App 安装包'), { status: 404, code: 'no-apk' })
        if (route === 'app/latest') return json(req, res, 200, { ok: true, value: { versionCode: b.versionCode, versionName: b.versionName, sha256: b.sha256, size: b.size } })
        const st = fs.statSync(b.file)
        res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-length': st.size, 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${path.basename(b.file)}"` })
        fs.createReadStream(b.file).on('error', () => res.destroy()).pipe(res)
        return
      }
      if (route === 'agents/mode' && isPost) { agents.setMode((await readJson(req, 4096)).mode); return json(req, res, 200, { ok: true, value: { mode: agents.settings.mode } }) }
      if (route === 'push/key' && !isPost) return json(req, res, 200, { ok: true, value: { publicKey: push.publicKey(), devices: push.list().length } })
      if (route === 'push/subscribe' && isPost) {
        const b = await readJson(req, 16 * 1024)
        return json(req, res, 200, { ok: true, value: { devices: push.subscribe(b.subscription, b.label) } })
      }
      if (route === 'push/unsubscribe' && isPost) return json(req, res, 200, { ok: true, value: { removed: push.unsubscribe((await readJson(req, 16 * 1024)).endpoint) } })
      if (route === 'push/test' && isPost) {
        const { endpoint } = await readJson(req, 16 * 1024)
        const sub = push.list().find((x) => x.endpoint === endpoint)
        if (!sub) throw Object.assign(new Error('这台设备还没开启推送'), { status: 404, code: 'not-subscribed' })
        const status = await push.sendTo(sub, { title: 'DSH 推送测试', body: '收到这条，说明锁屏提醒已经可以用了', tag: 'test' }, { urgency: 'high', ttl: 600 })
        return json(req, res, 200, { ok: true, value: { status } })
      }
      return json(req, res, 404, { ok: false, error: { code: 'not-found', message: route } })
    } catch (err) {
      const status = err.status || 502
      if (status >= 500) log(`api ${route} failed: ${err.message}`)
      if (!res.headersSent) json(req, res, status, { ok: false, error: { code: err.code || (err.name === 'TimeoutError' ? 'timeout' : 'upstream'), message: err.message } })
      else res.end()
    }
  }

  function events(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' })
    res.write('retry: 2000\n\n')
    const b = new Bridge(res, `ws://127.0.0.1:${apiPort()}`, log, () => bridges.delete(b), agents)
    bridges.add(b)
    req.on('close', () => b.close())
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://local')
      const p = url.pathname
      if (p === '/m') { res.writeHead(308, { location: '/m/' + url.search }); res.end(); return }
      if (p === '/m/' || p === '/m/index.html') return serveShell(req, res)
      if (p.startsWith('/m/api/')) {
        if (!trusted(req, trustedHosts)) return json(req, res, 403, { ok: false, error: { code: 'forbidden', message: 'untrusted request' } })
        return await api(p.slice(7), url, req, res)
      }
      return serveAsset(decodeURIComponent(p.slice(3)), req, res)
    } catch (err) {
      log(`handler error: ${err && err.message}`)
      if (!res.headersSent) { res.writeHead(500); res.end() } else res.end()
    }
  }

  function close() {
    clearTimeout(hubTimer)
    clearTimeout(hookTimer)
    clearInterval(watchSweep)
    for (const w of watched.values()) w.w.close()
    agents.close()
    presence.close()
    hub.stop()
    for (const b of [...bridges]) b.close()
  }

  return { handle, close }
}

/**
 * One phone connection: DSH mux + host WebSockets in, compact SSE frames out.
 *
 * Text deltas are buffered per session and flushed every ~90 ms as
 * [seq, text] pairs (a raw chunk frame is ~250 bytes for a few characters);
 * the per-part seq lets the phone drop exactly the parts its history page
 * already contained. Any non-delta frame for a session flushes that
 * session's buffer first, so ordering is preserved.
 *
 * Upstream loss ends the SSE response; the phone's EventSource reconnects,
 * and the fresh mux replays still-pending approvals/questions.
 */
class Bridge {
  constructor(res, wsBase, log, onClose, agents) {
    this.res = res
    this.log = log
    this.onClose = onClose
    this.agents = agents
    this.closed = false
    this.pending = new Map()
    this.timer = null
    this.toolSeen = new Map()
    this.turnAt = new Map()
    this.calls = new Map()
    this.sockets = [
      this.open(`${wsBase}/api/events.mux`, (env) => this.onMux(env)),
      this.open(`${wsBase}/api/events.host`, (env) => this.onHost(env)),
    ]
    // A data frame, not an SSE comment: EventSource hides comments from script,
    // and the phone's stall watchdog needs to see the heartbeat.
    this.ping = setInterval(() => this.send({ t: 'p' }), 15000)
    this.send({ t: 'hello', at: Date.now() })
    // Claude Code / Codex: their approvals use the same ask frames; anything else just says "refetch".
    if (agents) {
      const askFrame = (a) => ({ t: 'ask', s: a.s, rpc: a.rpc, id: a.id, tool: a.tool, title: a.what, detail: a.detail, why: a.title, remember: a.remember })
      this.onAgentAsk = (a) => this.send(askFrame(a))
      this.onAgentDone = (d) => this.send({ t: 'askDone', s: d.s, id: d.id, outcome: d.outcome })
      this.onAgentChange = () => {
        if (this.agentT) return
        this.agentT = setTimeout(() => { this.agentT = null; this.send({ t: 'agents' }) }, 300)
      }
      this.onAgentFail = (f) => this.send({ t: 'agentErr', s: f.s, msg: f.msg })
      agents.on('ask', this.onAgentAsk)
      agents.on('askDone', this.onAgentDone)
      agents.on('change', this.onAgentChange)
      agents.on('fail', this.onAgentFail)
      for (const a of agents.asks()) this.send(askFrame(a))
    }
  }

  open(url, onEnvelope) {
    const ws = new WebSocket(url)
    ws.onmessage = (ev) => {
      try { onEnvelope(JSON.parse(ev.data)) } catch (err) { this.log(`bridge frame error: ${err && err.message}`) }
    }
    ws.onerror = () => {}
    ws.onclose = () => this.close()
    return ws
  }

  write(s) {
    if (this.closed) return
    try { this.res.write(s) } catch { this.close() }
  }

  send(obj) {
    this.write(`data: ${JSON.stringify(obj)}\n\n`)
  }

  delta(s, seq, text) {
    let q = this.pending.get(s)
    if (!q) this.pending.set(s, (q = []))
    q.push([seq, text])
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; for (const id of [...this.pending.keys()]) this.flush(id) }, 90)
  }

  flush(s) {
    const q = this.pending.get(s)
    if (!q) return
    this.pending.delete(s)
    if (q.length) this.send({ t: 'd', s, p: q })
  }

  remember(item) {
    this.calls.set(item.id, { title: item.title, detail: item.detail })
    if (this.calls.size > 200) this.calls.delete(this.calls.keys().next().value)
  }

  onMux(env) {
    const f = env && env.payload
    if (!f) return
    const s = f.sessionId
    switch (f.type) {
      case 'session/event': return this.onEvent(s, f.event, f.view)
      case 'approval/requested':
        this.flush(s)
        return this.send({ t: 'ask', s, rpc: env.rpcId, id: f.approvalId, tool: f.toolName, call: f.callId, why: f.reason, ...(this.calls.get(f.callId) || {}) })
      case 'approval/resolved': return this.send({ t: 'askDone', s, id: f.approvalId, outcome: f.outcome })
      case 'question/requested': this.flush(s); return this.send({ t: 'q', s, rpc: env.rpcId, qs: f.questions })
      case 'question/resolved': return this.send({ t: 'qDone', s, rpc: f.questionRpcId, outcome: f.outcome })
      case 'session/queue': return this.send({ t: 'queue', s, items: foldQueue(f.items) })
      case 'session/projection':
        if (f.key === 'title' && typeof f.value === 'string') this.send({ t: 'title', s, title: f.value })
        return
      case 'stream/error': return this.send({ t: 'err', msg: f.error && f.error.message })
    }
  }

  onEvent(s, e, view) {
    if (!e) return
    switch (e.type) {
      case 'assistant/chunk': {
        const c = e.data && e.data.chunk
        if (!c) return
        if (c.type === 'text-delta') return this.delta(s, e.seq, c.text)
        if (c.type === 'block-start' && c.blockType === 'reasoning') { this.flush(s); return this.send({ t: 'think', s, seq: e.seq }) }
        if (c.type === 'tool-call-delta' && c.name && c.id) {
          let seen = this.toolSeen.get(s)
          if (!seen) this.toolSeen.set(s, (seen = new Set()))
          if (seen.has(c.id)) return
          seen.add(c.id)
          this.flush(s)
          return this.send({ t: 'tooling', s, seq: e.seq, name: c.name })
        }
        return
      }
      case 'user/message': {
        const it = foldUser(e)
        if (!it) return
        this.flush(s)
        return this.send({ t: 'item', s, it })
      }
      case 'assistant/message': this.flush(s); return this.send({ t: 'final', s, seq: e.seq, it: foldAssistant(e) })
      case 'step/start': this.flush(s); return this.send({ t: 'step', s, seq: e.seq })
      case 'tool/call': {
        if (e.data && e.data.name === 'todo_write') return
        this.flush(s)
        const it = foldCall(e, view)
        this.remember(it)
        return this.send({ t: 'item', s, it })
      }
      case 'tool/result': this.flush(s); return this.send({ t: 'result', s, seq: e.seq, ...foldResult(e, view) })
      case 'turn/start': this.turnAt.set(s, e.time); return this.send({ t: 'turn', s, seq: e.seq })
      case 'turn/end': {
        this.flush(s)
        this.toolSeen.delete(s)
        const at = this.turnAt.get(s)
        this.turnAt.delete(s)
        return this.send({ t: 'item', s, it: { k: 'end', seq: e.seq, reason: (e.data && e.data.reason && e.data.reason.kind) || 'completed', ms: at !== undefined ? e.time - at : undefined } })
      }
      case 'session/title': return this.send({ t: 'title', s, title: e.data && e.data.title })
      case 'todo/write': return this.send({ t: 'todo', s, todos: e.data && e.data.todos })
    }
  }

  onHost(env) {
    const f = env && env.payload
    if (!f) return
    switch (f.type) {
      case 'host/session-status': return this.send({ t: 'run', s: f.sessionId, on: f.running })
      case 'host/agent-error': return this.send({ t: 'agentErr', s: f.sessionId, msg: f.message })
      case 'host/session-added':
      case 'host/session-removed':
      case 'host/workspace-changed':
      case 'host/workspace-removed':
      case 'host/workspace-order-changed':
      case 'host/archived-sessions-changed':
        return this.send({ t: 'list' })
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.ping)
    clearTimeout(this.timer)
    clearTimeout(this.agentT)
    if (this.agents) {
      this.agents.off('ask', this.onAgentAsk)
      this.agents.off('askDone', this.onAgentDone)
      this.agents.off('change', this.onAgentChange)
      this.agents.off('fail', this.onAgentFail)
    }
    for (const ws of this.sockets) { try { ws.close() } catch {} }
    try { this.res.end() } catch {}
    this.onClose()
  }
}
