// Fixtures mirror event shapes captured from real DSH session logs (2026-09-21).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldHistory, foldCall, foldResult, foldQueue, clip, CAP } from '../fold.js'

const ev = (seq, type, data, extra = {}) => ({ event: { type, seq, time: 1000 + seq, data }, ...extra })
const chunk = (seq, c) => ev(seq, 'assistant/chunk', { turn: 1, step: 1, chunk: c })

test('chunks of a finalized message are dropped; message text kept', () => {
  const f = foldHistory([
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'user/message', { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' }, role: 'user', id: 'u1' }),
    ev(3, 'step/start', { turn: 1, step: 1 }),
    chunk(4, { type: 'block-start', index: 0, blockType: 'reasoning' }),
    chunk(5, { type: 'reasoning-delta', index: 0, text: '想' }),
    chunk(6, { type: 'text-delta', index: 1, text: '你' }),
    chunk(7, { type: 'text-delta', index: 1, text: '好！' }),
    ev(8, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '你好！' }] } }),
    ev(9, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ])
  assert.equal(f.partial, null)
  assert.deepEqual(f.items.map((i) => i.k), ['u', 'a', 'end'])
  assert.equal(f.items[0].text, '你好')
  assert.equal(f.items[1].text, '你好！')
  assert.equal(f.items[1].think, '想')
  assert.equal(f.items[2].reason, 'completed')
  assert.equal(f.items[2].ms, 8)
  assert.equal(f.firstSeq, 1)
  assert.equal(f.lastSeq, 9)
})

test('unfinalized tail becomes the partial (running session)', () => {
  const f = foldHistory([
    ev(10, 'step/start', { turn: 2, step: 1 }),
    chunk(11, { type: 'block-start', index: 0, blockType: 'reasoning' }),
    chunk(12, { type: 'text-delta', index: 1, text: '正在' }),
    chunk(13, { type: 'text-delta', index: 1, text: '处理' }),
    chunk(14, { type: 'tool-call-delta', index: 2, id: 'call_1', name: 'pwsh', argumentsDelta: '' }),
  ])
  assert.deepEqual(f.partial, { text: '正在处理', think: true, tool: 'pwsh' })
})

test('interrupted turn clears a dangling partial', () => {
  const f = foldHistory([
    chunk(1, { type: 'text-delta', index: 0, text: 'half' }),
    ev(2, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
  ])
  assert.equal(f.partial, null)
  assert.equal(f.items[0].reason, 'interrupted')
})

test('tool call merges its result; terminal view uses description as title', () => {
  const f = foldHistory([
    ev(1, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"Get-Date"}' },
      { view: { for: 'call', view: { card: 'terminal', title: 'Get-Date', description: 'Show the date' } } }),
    ev(2, 'tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }], isError: false }], role: 'user', id: 'r1' } },
      { view: { for: 'result', view: { card: 'terminal', output: 'Monday\r\n', exitCode: 0 } } }),
  ])
  assert.equal(f.items.length, 1)
  const t = f.items[0]
  assert.equal(t.k, 't')
  assert.equal(t.kind, 'execute')
  assert.equal(t.title, 'Show the date')
  assert.equal(t.detail, 'Get-Date')
  assert.equal(t.done, true)
  assert.equal(t.err, false)
  assert.equal(t.out, 'Monday\n')
})

test('error result and non-zero exit are surfaced', () => {
  const r = foldResult(
    { type: 'tool/result', seq: 5, time: 1, data: { message: { source: { kind: 'tool', callId: 'c9' }, content: [{ type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: 'boom' }], isError: true }] } } },
    { for: 'result', view: { card: 'terminal', output: 'boom', exitCode: 1 } },
  )
  assert.deepEqual(r, { id: 'c9', err: true, out: 'boom\n[exit 1]' })
})

test('generic result without a view falls back to text content', () => {
  const r = foldResult({ type: 'tool/result', seq: 1, time: 1, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'ok' }], isError: false }] } } })
  assert.deepEqual(r, { id: 'c2', err: false, out: 'ok' })
})

test('diff call previews the new text; read result never ships file contents', () => {
  const c = foldCall(
    { type: 'tool/call', seq: 1, time: 1, data: { callId: 'e1', name: 'edit', arguments: '{}' } },
    { for: 'call', view: { card: 'diff', title: 'Edit a.js', diffs: [{ path: 'a.js', oldText: 'x', newText: 'y' }] } },
  )
  assert.equal(c.kind, 'edit')
  assert.equal(c.detail, '~ a.js\ny')
  const r = foldResult(
    { type: 'tool/result', seq: 2, time: 1, data: { message: { content: [{ type: 'tool-result', toolCallId: 'e2', content: [{ type: 'text', text: 'SECRET FILE BODY' }] }] } } },
    { for: 'result', view: { card: 'read', path: 'a.js', totalLines: 85, lines: [{ number: 1, text: 'SECRET FILE BODY' }] } },
  )
  assert.equal(r.out, 'a.js · 共 85 行')
})

test('todo_write is not a tool row; todo/write updates todos', () => {
  const f = foldHistory([
    ev(1, 'tool/call', { callId: 't1', name: 'todo_write', arguments: '{}' }),
    ev(2, 'todo/write', { todos: [{ content: 'a', status: 'completed' }] }),
    ev(3, 'session/title', { title: '标题', messageSeqs: [], source: { kind: 'user' } }),
  ])
  assert.equal(f.items.length, 0)
  assert.deepEqual(f.todos, [{ content: 'a', status: 'completed' }])
  assert.equal(f.title, '标题')
})

test('heavy / model-only events are skipped', () => {
  const f = foldHistory([
    ev(1, 'request/header', { header: { system: 'x'.repeat(100000) } }),
    ev(2, 'request/context', { provider: 'p', model: 'm' }),
    ev(3, 'permission/preset', { preset: 'workspace-write' }),
  ])
  assert.equal(f.items.length, 0)
  assert.ok(JSON.stringify(f).length < 200)
})

test('harness-injected user/message context is hidden; human prompt kept with rpcId', () => {
  const f = foldHistory([
    ev(1, 'user/message', { content: [{ type: 'text', text: 'The approval policy changed' }], source: { kind: 'plugin', plugin: 'user-approval' }, role: 'user', id: 'a' }),
    ev(2, 'user/message', { content: [{ type: 'text', text: '真的问题' }], source: { kind: 'user', rpcId: 'r-1', clientTimeZone: 'Asia/Shanghai' }, role: 'user', id: 'b' }),
    ev(3, 'user/message', { content: [{ type: 'text', text: '<system-reminder>skills…</system-reminder>' }], source: { kind: 'skill-catalog', form: 'catalog' }, role: 'user', id: 'c' }),
    ev(4, 'user/message', { content: [{ type: 'text', text: '<system-reminder>AGENTS.md</system-reminder>' }], source: { kind: 'agent-instructions' }, role: 'user', id: 'd' }),
  ])
  assert.equal(f.items.length, 1)
  assert.equal(f.items[0].text, '真的问题')
  assert.equal(f.items[0].rid, 'r-1')
})

test('user images are referenced, not inlined', () => {
  const f = foldHistory([
    ev(1, 'user/message', { content: [{ type: 'image', attachment: { attachmentId: 'sha256:ab', mediaType: 'image/png', width: 10, height: 20, bytes: 99 } }, { type: 'text', text: '看图' }], role: 'user', id: 'u' }),
  ])
  assert.deepEqual(f.items[0].imgs, [{ id: 'sha256:ab', w: 10, h: 20 }])
})

test('clip keeps head and tail within the cap', () => {
  const s = 'H'.repeat(1000) + 'T'.repeat(3000)
  const c = clip(s)
  assert.ok(c.length <= CAP + 3)
  assert.ok(c.startsWith('H'))
  assert.ok(c.endsWith('T'))
})

test('queue hides model-only context items', () => {
  const q = foldQueue([
    { id: 'a', placement: 'queued', message: { content: [{ type: 'text', text: '下一条' }] } },
    { id: 'b', placement: 'context', message: { content: [{ type: 'text', text: 'hidden' }] } },
  ])
  assert.deepEqual(q, [{ id: 'a', place: 'queued', text: '下一条' }])
})
