/**
 * Event folding: DSH's raw session events -> compact items for the phone.
 *
 * Why this exists
 * ---------------
 * `session.history` returns every raw event, and 89% of the bytes are
 * `assistant/chunk` streaming fragments (measured: 30 messages x 6 sessions =
 * 22.9 MB). `request/header` events additionally repeat the whole system
 * prompt. Shipping that over a mobile network through a relay is what made the
 * phone slow. Folding here, on the home PC, sends only what a phone renders:
 * user text, assistant text, one line per tool call, turn boundaries.
 *
 * Every function is pure (no I/O) so it can be unit tested against real
 * event shapes.
 */

/** Longest preview kept for tool arguments / outputs. Full text stays on the PC. */
export const CAP = 1500

/** Head+tail clip: tool output errors usually sit at the end. */
export function clip(s, n = CAP) {
  if (typeof s !== 'string') return ''
  if (s.length <= n) return s
  const head = Math.floor(n * 0.3)
  return s.slice(0, head) + '\n…\n' + s.slice(s.length - (n - head))
}

const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s || '')

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function imagesOf(content) {
  if (!Array.isArray(content)) return []
  return content
    .filter((b) => b && b.type === 'image' && b.attachment && b.attachment.attachmentId)
    .map((b) => ({ id: b.attachment.attachmentId, w: b.attachment.width, h: b.attachment.height }))
}

/**
 * user/message: `data` is the message itself. The same event type also carries
 * harness-injected context (source.kind 'skill-catalog', 'agent-instructions',
 * 'plugin' runtime snapshots, approval-policy notes); only a human-authored
 * message (source.kind 'user') becomes a chat bubble.
 * @returns the bubble, or null for injected context.
 */
export function foldUser(e) {
  const m = e.data || {}
  if (m.source && m.source.kind !== 'user') return null
  return { k: 'u', seq: e.seq, time: e.time, rid: m.source && m.source.rpcId, text: textOf(m.content), imgs: imagesOf(m.content) }
}

/** assistant/message: text + trimmed reasoning. Tool-call blocks are rendered from tool/call events. */
export function foldAssistant(e) {
  const content = (e.data && e.data.message && e.data.message.content) || []
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim()
  const think = content.filter((b) => b.type === 'reasoning').map((b) => b.text).join('\n\n').trim()
  if (!text && !think) return null
  return { k: 'a', seq: e.seq, time: e.time, text, think: cut(think, 1200) }
}

const KIND_BY_TOOL = {
  pwsh: 'execute', bash: 'execute', job_output: 'execute',
  read: 'read', read_image: 'read',
  write: 'edit', edit: 'edit', str_replace_editor: 'edit',
  grep: 'search', glob: 'search', web_search: 'web', web_fetch: 'web',
  subagent: 'agent', send_message: 'agent', report: 'agent',
}

function kindOf(name, v) {
  if (v && v.card === 'diff') return 'edit'
  if (v && v.card === 'terminal') return 'execute'
  if (v && v.kind && v.kind !== 'other') return v.kind
  if (/^mcp__chrome__/.test(name || '')) return 'web'
  return KIND_BY_TOOL[name] || 'other'
}

function prettyArgs(raw) {
  if (typeof raw !== 'string') return ''
  try {
    const o = JSON.parse(raw)
    if (o && typeof o === 'object') {
      const vals = Object.values(o)
      if (vals.length === 1 && typeof vals[0] === 'string') return vals[0]
      return JSON.stringify(o, null, 1)
    }
  } catch {}
  return raw
}

function diffPreview(diffs) {
  if (!Array.isArray(diffs)) return ''
  return diffs
    .map((d) => (d.oldText == null ? `+ ${d.path}` : `~ ${d.path}`) + '\n' + (d.newText == null ? '' : d.newText))
    .join('\n\n')
}

function firstLine(s) {
  if (typeof s !== 'string') return ''
  const i = s.indexOf('\n')
  return (i < 0 ? s : s.slice(0, i) + ' …').trim()
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'file', 'target_file', 'output', 'output_path', 'outputPath', 'dest', 'destination']

/**
 * File paths a tool call names (diff targets, `path`-like arguments), for the
 * phone's "open file" chips. The server confines every path to the session's
 * workspace, so this may over-report; it must not throw.
 */
export function pathsOf(args, v) {
  const out = []
  const add = (p) => { if (typeof p === 'string' && p.trim() && p.length < 1024 && !/[\r\n]/.test(p) && !out.includes(p)) out.push(p) }
  if (v && Array.isArray(v.diffs)) for (const d of v.diffs) add(d && d.path)
  if (v && typeof v.path === 'string') add(v.path)
  let o = args
  if (typeof args === 'string') { try { o = JSON.parse(args) } catch { o = null } }
  if (o && typeof o === 'object') for (const k of PATH_KEYS) add(o[k])
  return out.slice(0, 6)
}

/** tool/call (+ host presenter view) -> one compact row. */
export function foldCall(e, view) {
  const d = e.data || {}
  const v = view && view.for === 'call' ? view.view : undefined
  let title = (v && v.title) || d.name || '工具'
  let detail
  if (v && v.card === 'terminal') {
    detail = v.title || ''
    title = v.description || v.title || d.name
  } else if (v && v.card === 'diff') {
    detail = diffPreview(v.diffs)
  } else if (v && typeof v.rawInput === 'string') {
    detail = v.rawInput
  } else {
    detail = prettyArgs(d.arguments)
  }
  const row = {
    k: 't', seq: e.seq, time: e.time, id: d.callId, name: d.name,
    kind: kindOf(d.name, v), title: cut(firstLine(title), 160), detail: clip(detail),
  }
  const paths = pathsOf(d.arguments, v)
  if (paths.length) row.paths = paths
  // The full text stays on the PC; /m/api/call serves it when the phone asks.
  if ((typeof detail === 'string' && detail.length > CAP) || (v && v.card === 'diff')) row.more = true
  return row
}

function searchSummary(v) {
  const files = Array.isArray(v.files) ? v.files : []
  const lines = []
  for (const f of files.slice(0, 8)) {
    lines.push(f.path)
    for (const m of (f.matches || []).slice(0, 3)) lines.push(`  ${m.lineNumber}: ${m.line}`)
  }
  const total = v.total != null ? v.total : files.length
  return `${total} 处匹配\n` + lines.join('\n')
}

/** The tool call a tool/result event answers. */
export function resultCallId(e) {
  const msg = (e.data && e.data.message) || {}
  const block = (msg.content || []).find((b) => b && b.type === 'tool-result')
  return (block && block.toolCallId) || (msg.source && msg.source.callId)
}

/** tool/result -> {id, err, out}; merged into the call row by the caller. */
export function foldResult(e, view) {
  const msg = (e.data && e.data.message) || {}
  const block = (msg.content || []).find((b) => b && b.type === 'tool-result')
  const id = resultCallId(e)
  const v = view && view.for === 'result' ? view.view : undefined
  let out
  if (v && v.card === 'terminal') out = (v.output || '') + (v.exitCode ? `\n[exit ${v.exitCode}]` : '')
  else if (v && v.card === 'read') out = `${v.path || ''}${v.totalLines ? ` · 共 ${v.totalLines} 行` : ''}`
  else if (v && v.card === 'search') out = searchSummary(v)
  else if (v && v.card === 'diff') out = ''
  else out = textOf(block && block.content)
  out = String(out || '').replace(/\r\n/g, '\n')
  const r = { id, err: Boolean(block && block.isError), out: clip(out) }
  if (out.length > CAP) r.more = true
  if (v && v.card === 'read' && typeof v.path === 'string') r.paths = [v.path]
  return r
}

/** Longest text of one field /m/api/call returns (a terminal can print megabytes). */
export const FULL_CAP = 512 * 1024

function capFull(s) {
  if (typeof s !== 'string') return { text: '', cut: false }
  return s.length > FULL_CAP ? { text: clip(s, FULL_CAP), cut: true } : { text: s, cut: false }
}

/**
 * The unclipped detail of one tool call, for the phone's result viewer.
 * @param callEntry - `{event, view}` of the tool/call.
 * @param resultEntry - `{event, view}` of its tool/result, when finished.
 */
export function fullCall(callEntry, resultEntry) {
  const e = callEntry.event
  const d = e.data || {}
  const cv = callEntry.view && callEntry.view.for === 'call' ? callEntry.view.view : undefined
  const row = foldCall(e, callEntry.view)
  const input = capFull(cv && cv.card === 'terminal' ? cv.title || '' : cv && typeof cv.rawInput === 'string' ? cv.rawInput : prettyArgs(d.arguments))
  const out = { id: row.id, name: row.name, kind: row.kind, title: row.title, input: input.text, paths: row.paths || [] }
  if (cv && cv.card === 'diff' && Array.isArray(cv.diffs)) {
    out.diffs = cv.diffs.map((x) => ({ path: x.path, oldText: x.oldText == null ? null : capFull(x.oldText).text, newText: x.newText == null ? null : capFull(x.newText).text }))
  }
  let truncated = input.cut
  if (resultEntry) {
    const msg = (resultEntry.event.data && resultEntry.event.data.message) || {}
    const block = (msg.content || []).find((b) => b && b.type === 'tool-result')
    const rv = resultEntry.view && resultEntry.view.for === 'result' ? resultEntry.view.view : undefined
    let text
    if (rv && rv.card === 'terminal') text = (rv.output || '') + (rv.exitCode ? `\n[exit ${rv.exitCode}]` : '')
    else text = textOf(block && block.content)
    const o = capFull(String(text || '').replace(/\r\n/g, '\n'))
    out.out = o.text
    out.err = Boolean(block && block.isError)
    out.done = true
    truncated = truncated || o.cut
    if (rv && rv.card === 'read' && typeof rv.path === 'string' && !out.paths.includes(rv.path)) out.paths.push(rv.path)
  }
  if (truncated) out.cut = true
  return out
}

/** Fold one streaming chunk into an in-flight partial. */
export function applyChunk(p, c) {
  p = p || { text: '', think: false, tool: null }
  if (!c) return p
  if (c.type === 'text-delta' && typeof c.text === 'string') p.text += c.text
  else if (c.type === 'reasoning-delta' || (c.type === 'block-start' && c.blockType === 'reasoning')) p.think = true
  else if (c.type === 'tool-call-delta' && c.name) p.tool = c.name
  return p
}

/**
 * Fold one history page (entries = [{event, view}] in seq order).
 * @returns items, the unfinalized tail (partial), seq bounds, latest title/todos.
 */
export function foldHistory(entries) {
  const items = []
  const calls = new Map()
  let partial = null
  let title
  let todos
  let turnStart = null
  let firstSeq = Infinity
  let lastSeq = -1
  for (const entry of entries || []) {
    const e = entry && entry.event
    if (!e) continue
    if (e.seq < firstSeq) firstSeq = e.seq
    if (e.seq > lastSeq) lastSeq = e.seq
    switch (e.type) {
      case 'user/message': {
        const u = foldUser(e)
        if (u) items.push(u)
        break
      }
      case 'assistant/chunk':
        partial = applyChunk(partial, e.data && e.data.chunk)
        break
      case 'assistant/message': {
        partial = null
        const a = foldAssistant(e)
        if (a) items.push(a)
        break
      }
      case 'step/start':
        partial = null
        break
      case 'tool/call': {
        if (e.data && e.data.name === 'todo_write') break
        const t = foldCall(e, entry.view)
        calls.set(t.id, t)
        items.push(t)
        break
      }
      case 'tool/result': {
        const r = foldResult(e, entry.view)
        const t = calls.get(r.id)
        if (t) {
          Object.assign(t, { done: true, err: r.err, out: r.out, rseq: e.seq })
          if (r.more) t.more = true
          if (r.paths) t.paths = [...new Set([...(t.paths || []), ...r.paths])]
        }
        break
      }
      case 'turn/start':
        turnStart = e.time
        break
      case 'turn/end':
        partial = null
        items.push({
          k: 'end', seq: e.seq,
          reason: (e.data && e.data.reason && e.data.reason.kind) || 'completed',
          ms: turnStart ? e.time - turnStart : undefined,
        })
        turnStart = null
        break
      case 'session/title':
        title = e.data && e.data.title
        break
      case 'todo/write':
        todos = e.data && e.data.todos
        break
    }
  }
  if (partial && !partial.text && !partial.think && !partial.tool) partial = null
  return { items, partial, firstSeq: firstSeq === Infinity ? -1 : firstSeq, lastSeq, title, todos }
}

/** Compact inbox snapshot for the queue dock (context items are model-only). */
export function foldQueue(items) {
  return (items || [])
    .filter((i) => i && i.placement !== 'context')
    .map((i) => ({ id: i.id, place: i.placement, text: cut(textOf(i.message && i.message.content), 300) }))
}
