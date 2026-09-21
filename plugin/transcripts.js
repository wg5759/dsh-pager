/**
 * Claude Code and Codex session files -> the phone's chat items (the same
 * item shapes fold.js produces for DSH: u / a / t / end).
 *
 *   Claude Code  ~/.claude/projects/<project>/<session>.jsonl
 *   Codex        <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<session>.jsonl
 *
 * Only the tail of a file is read (they grow to tens of MB) and every
 * function here is pure apart from the file reads, so the folding is tested
 * against real line shapes.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const TAIL_BYTES = 4 * 1024 * 1024
const CAP = 1500

function clip(s, n = CAP) {
  if (typeof s !== 'string') return ''
  if (s.length <= n) return s
  const head = Math.floor(n * 0.3)
  return s.slice(0, head) + '\n…\n' + s.slice(s.length - (n - head))
}
const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s || '')
const base = (p) => { const s = String(p || '').replace(/[\\/]+$/, ''); return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1) || s }
const time = (t) => { const v = Date.parse(t); return Number.isFinite(v) ? v : undefined }

/** Parse JSONL text, skipping a torn first line (tail reads) and junk. */
export function parseLines(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

/** Last `bytes` of a file as text (starting at a line boundary). */
export function readTail(file, bytes = TAIL_BYTES) {
  const st = fs.statSync(file)
  const start = Math.max(0, st.size - bytes)
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(st.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return { text, truncated: start > 0, size: st.size, at: st.mtimeMs }
  } finally { fs.closeSync(fd) }
}

const KIND = {
  Bash: 'execute', PowerShell: 'execute', shell: 'execute', exec_command: 'execute', local_shell: 'execute',
  Read: 'read', NotebookRead: 'read', view_image: 'read',
  Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', apply_patch: 'edit',
  Grep: 'search', Glob: 'search', WebSearch: 'web', WebFetch: 'web', web_search: 'web',
  Task: 'agent', Agent: 'agent', spawn_agent: 'agent', send_message: 'agent',
}

function toolRow(id, name, input, t) {
  const i = input && typeof input === 'object' ? input : {}
  const cmd = Array.isArray(i.command) ? i.command.join(' ') : i.command || i.cmd
  const file = i.file_path || i.path || i.notebook_path
  let title = name
  let detail = ''
  if (typeof cmd === 'string' && cmd) { title = i.description || cut(cmd.split('\n')[0], 120); detail = cmd }
  else if (file) { title = `${name} ${base(file)}`; detail = String(file) }
  else if (i.pattern) { title = `${name} ${cut(String(i.pattern), 80)}`; detail = String(i.pattern) }
  else if (i.url || i.query) { title = `${name} ${cut(String(i.url || i.query), 80)}`; detail = String(i.url || i.query) }
  else if (typeof input === 'string') detail = input
  else { try { detail = JSON.stringify(i, null, 1) } catch {} if (detail === '{}') detail = '' }
  const row = { k: 't', id, name, kind: KIND[name] || (/^mcp__/.test(name || '') ? 'web' : 'other'), title: cut(title || '工具', 160), detail: clip(detail), time: t }
  if (file) row.paths = [String(file)]
  return row
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
}

/** Claude Code transcript entries -> items + title. */
export function foldClaude(entries) {
  const items = []
  const calls = new Map()
  let title = ''
  let firstPrompt = ''
  let asst = null // merge the text blocks of one assistant message
  for (const o of entries) {
    if (!o || typeof o !== 'object' || o.isSidechain) continue
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') { title = o.customTitle; continue }
    if (o.type === 'summary' && typeof o.summary === 'string' && !title) { title = o.summary; continue }
    const m = o.message
    if (!m) continue
    const t = time(o.timestamp)
    if (o.type === 'user') {
      const c = m.content
      if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) {
        for (const b of c) {
          if (!b || b.type !== 'tool_result') continue
          const row = calls.get(b.tool_use_id)
          if (row) Object.assign(row, { done: true, err: Boolean(b.is_error), out: clip(textOf(b.content).replace(/\r\n/g, '\n')) })
        }
        continue
      }
      if (o.isMeta || o.isCompactSummary) continue
      const text = textOf(c).trim()
      // Harness-injected turns (command output, reminders) start with a tag; a human prompt does not.
      if (!text || /^<(command-|local-command|system-reminder|bash-)/.test(text)) continue
      if (!firstPrompt) firstPrompt = text
      items.push({ k: 'u', text: clip(text, 4000), time: t })
      asst = null
      continue
    }
    if (o.type === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b) continue
        if (b.type === 'text' && b.text && b.text.trim()) {
          if (asst && asst.mid === m.id) asst.text = asst.text ? asst.text + '\n\n' + b.text : b.text
          else { asst = { k: 'a', text: b.text, think: '', mid: m.id, time: t }; items.push(asst) }
        } else if (b.type === 'thinking' && b.thinking) {
          if (!asst || asst.mid !== m.id) { asst = { k: 'a', text: '', think: '', mid: m.id, time: t }; items.push(asst) }
          asst.think = cut((asst.think ? asst.think + '\n\n' : '') + b.thinking, 1200)
        } else if (b.type === 'tool_use') {
          const row = toolRow(b.id, b.name, b.input, t)
          calls.set(b.id, row)
          items.push(row)
          asst = null
        }
      }
    }
  }
  for (const it of items) delete it.mid
  return { items: items.filter((it) => it.k !== 'a' || it.text || it.think), title: title || cut(firstPrompt.split('\n')[0], 60) }
}

/** Codex rollout entries -> items + title + cwd. */
export function foldCodex(entries) {
  const items = []
  const calls = new Map()
  let firstPrompt = ''
  let cwd = ''
  for (const o of entries) {
    if (!o || typeof o !== 'object' || !o.payload) continue
    const p = o.payload
    const t = time(o.timestamp)
    if (o.type === 'session_meta') { if (p.cwd) cwd = p.cwd; continue }
    if (o.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
      const text = p.message.trim()
      if (!text) continue
      if (!firstPrompt) firstPrompt = text
      items.push({ k: 'u', text: clip(text, 4000), time: t })
      continue
    }
    if (o.type === 'event_msg' && p.type === 'task_complete') { items.push({ k: 'end', reason: p.error ? 'error' : 'completed', ms: p.duration_ms, time: t }); continue }
    if (o.type !== 'response_item') continue
    if (p.type === 'message' && p.role === 'assistant') {
      const text = textOf(p.content).trim()
      if (text) items.push({ k: 'a', text, think: '', time: t })
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      let input = p.input
      if (p.type === 'function_call') { try { input = JSON.parse(p.arguments) } catch { input = p.arguments } }
      if (p.type === 'local_shell_call') input = p.action || {}
      const row = toolRow(p.call_id, p.name || (p.type === 'local_shell_call' ? 'shell' : 'tool'), input, t)
      calls.set(p.call_id, row)
      items.push(row)
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const row = calls.get(p.call_id)
      if (!row) continue
      let out = typeof p.output === 'string' ? p.output : textOf(p.output)
      // Many tools wrap their output as JSON {output, metadata:{exit_code}}.
      try { const j = JSON.parse(out); if (j && typeof j.output === 'string') { out = j.output; if (j.metadata && j.metadata.exit_code) row.err = true } } catch {}
      Object.assign(row, { done: true, out: clip(String(out || '').replace(/\r\n/g, '\n')) })
    }
  }
  return { items, title: cut(firstPrompt.split('\n')[0], 60), cwd }
}

/** Fold one session file; `src` picks the dialect. Items get seq numbers for the chat renderer. */
export function foldFile(file, src, bytes = TAIL_BYTES) {
  const tail = readTail(file, bytes)
  const entries = parseLines(tail.text)
  const f = src === 'codex' ? foldCodex(entries) : foldClaude(entries)
  const items = f.items.slice(-150)
  items.forEach((it, i) => { it.seq = i + 1; if (it.k === 't' && !it.id) it.id = 'x' + it.seq })
  return { items, title: f.title, cwd: f.cwd || (src === 'claude' ? (entries.find((e) => e && e.cwd) || {}).cwd || '' : ''), truncated: tail.truncated, at: tail.at }
}

/**
 * Folder and first prompt from the head of a session file: Codex writes its
 * working folder only in the first line, which a tail read misses.
 */
export function headMeta(file, src, bytes = 128 * 1024) {
  const fd = fs.openSync(file, 'r')
  let text
  try {
    const buf = Buffer.alloc(Math.min(bytes, fs.fstatSync(fd).size))
    fs.readSync(fd, buf, 0, buf.length, 0)
    text = buf.toString('utf8')
  } finally { fs.closeSync(fd) }
  const f = src === 'codex' ? foldCodex(parseLines(text)) : foldClaude(parseLines(text))
  const cwd = f.cwd || (src === 'claude' ? (parseLines(text).find((e) => e && e.cwd) || {}).cwd || '' : '')
  return { cwd, title: f.title }
}

/**
 * Recently written session files of both tools, newest first, for sessions the
 * hooks have not told us about (before installing them, or after a restart).
 */
export function recentFiles({ days = 7, max = 30, claudeDir = path.join(os.homedir(), '.claude', 'projects'), codexDir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions') } = {}) {
  const since = Date.now() - days * 864e5
  const out = []
  const add = (file, src, id) => { try { const st = fs.statSync(file); if (st.mtimeMs >= since && st.size > 0) out.push({ file, src, id, at: st.mtimeMs, size: st.size }) } catch {} }
  try {
    for (const d of fs.readdirSync(claudeDir)) {
      let names = []
      try { names = fs.readdirSync(path.join(claudeDir, d)) } catch { continue }
      for (const f of names) if (/^[0-9a-f-]{36}\.jsonl$/.test(f)) add(path.join(claudeDir, d, f), 'claude', f.slice(0, 36))
    }
  } catch {}
  // Codex keeps a dated tree; the last 8 days' folders are enough for a 7-day window.
  for (let i = 0; i <= days + 1; i++) {
    const day = new Date(Date.now() - i * 864e5)
    const dir = path.join(codexDir, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const f of names) { const m = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/.exec(f); if (m) add(path.join(dir, f), 'codex', m[1]) }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, max)
}
