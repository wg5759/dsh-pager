import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { NotifyHub, turnEndNotice, previewText, MIN_NOTIFY_MS } from '../notify.js'

const hub = () => new NotifyHub({ wsBase: () => 'ws://unused', listSessions: async () => ({ items: [] }) })
const mux = (payload, rpcId = 'rpc-x') => ({ type: 'server-request', rpcId, payload })
const ev = (s, type, seq, time, data) => mux({ type: 'session/event', sessionId: s, event: { type, seq, time, data } })

test('turn-end verdicts', () => {
  assert.equal(turnEndNotice({ kind: 'completed', ms: MIN_NOTIFY_MS }), 'done')
  assert.equal(turnEndNotice({ kind: 'completed', ms: 3000 }), null)
  assert.equal(turnEndNotice({ kind: 'completed', ms: 3000, phone: true }), 'done')
  assert.equal(turnEndNotice({ kind: 'completed', ms: undefined }), 'done') // started before the hub: assume long
  assert.equal(turnEndNotice({ kind: 'completed', ms: 60000, sub: true }), null)
  assert.equal(turnEndNotice({ kind: 'interrupted', ms: 60000 }), null)
  assert.equal(turnEndNotice({ kind: 'aborted', ms: 60000 }), null)
  assert.equal(turnEndNotice({ kind: 'error', ms: 1000 }), 'error')
})

test('preview strips markdown and clips', () => {
  assert.equal(previewText('## 结果\n**已完成**：`build.sh` 跑通\n```\nlog\n```\n- 第一项'), '结果 已完成：build.sh 跑通 第一项')
  assert.equal(previewText('x'.repeat(200)).length, 91)
})

test('long turn emits done with title, duration and preview', () => {
  const h = hub()
  const out = []
  h.emit = ((orig) => (e) => { out.push(orig.call(h, e)); return e })(h.emit)
  h.titles.set('s1', '**Session Title:** 部署网关')
  h.onMux(ev('s1', 'turn/start', 1, 1000, { turn: 1 }))
  h.onMux(ev('s1', 'assistant/message', 2, 5000, { message: { content: [{ type: 'text', text: '**搞定**，网关已重启' }] } }))
  h.onMux(ev('s1', 'turn/end', 3, 16000, { reason: { kind: 'completed' } }))
  assert.equal(out.length, 1)
  assert.deepEqual({ t: out[0].t, s: out[0].s, title: out[0].title, ms: out[0].ms, preview: out[0].preview }, { t: 'done', s: 's1', title: '部署网关', ms: 15000, preview: '搞定，网关已重启' })
  assert.equal(out[0].n, 1)
})

test('quick desktop turn is silent; quick phone turn notifies once', () => {
  const h = hub()
  const out = []
  h.emit = ((orig) => (e) => { out.push(orig.call(h, e)); return e })(h.emit)
  h.onMux(ev('s2', 'turn/start', 1, 0, {}))
  h.onMux(ev('s2', 'turn/end', 2, 2000, { reason: { kind: 'completed' } }))
  assert.equal(out.length, 0)
  h.markPhone('s2')
  h.onMux(ev('s2', 'turn/start', 3, 10000, {}))
  h.onMux(ev('s2', 'turn/end', 4, 12000, { reason: { kind: 'completed' } }))
  h.onMux(ev('s2', 'turn/start', 5, 20000, {}))
  h.onMux(ev('s2', 'turn/end', 6, 22000, { reason: { kind: 'completed' } }))
  assert.deepEqual(out.map((e) => e.t), ['done']) // the phone mark is consumed by one turn
})

test('subagent turns never notify', () => {
  const h = hub()
  const out = []
  h.emit = ((orig) => (e) => { out.push(orig.call(h, e)); return e })(h.emit)
  h.onHost({ payload: { type: 'host/session-added', sessionId: 'sub1', origin: 'subagent', blank: true } })
  h.onMux(ev('sub1', 'turn/start', 1, 0, {}))
  h.onMux(ev('sub1', 'turn/end', 2, 60000, { reason: { kind: 'completed' } }))
  assert.equal(out.length, 0)
})

test('approval ask carries the tool call title; resolve withdraws it', () => {
  const h = hub()
  const out = []
  h.emit = ((orig) => (e) => { out.push(orig.call(h, e)); return e })(h.emit)
  h.titles.set('s3', '清理')
  h.onMux(mux({ type: 'session/event', sessionId: 's3', event: { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c1', name: 'pwsh', arguments: '{}' } }, view: { for: 'call', view: { card: 'terminal', title: 'Remove-Item x', description: '删除临时文件' } } }))
  h.onMux(mux({ type: 'approval/requested', sessionId: 's3', approvalId: 'ap1', toolName: 'pwsh', callId: 'c1' }, 'rpc-ap1'))
  h.onMux(mux({ type: 'approval/requested', sessionId: 's3', approvalId: 'ap1', toolName: 'pwsh', callId: 'c1' }, 'rpc-ap1')) // mux replay: no duplicate
  h.onMux(mux({ type: 'approval/resolved', sessionId: 's3', approvalId: 'ap1', outcome: 'rejected' }))
  assert.deepEqual(out.map((e) => e.t), ['ask', 'askDone'])
  assert.equal(out[0].what, '删除临时文件')
  assert.equal(out[0].detail, 'Remove-Item x')
  assert.equal(out[0].rpc, 'rpc-ap1')
})

test('question notices use the first question text', () => {
  const h = hub()
  const out = []
  h.emit = ((orig) => (e) => { out.push(orig.call(h, e)); return e })(h.emit)
  h.onMux(mux({ type: 'question/requested', sessionId: 's4', questions: [{ id: 'q1', question: '发到哪个平台？' }] }, 'rpc-q1'))
  h.onMux(mux({ type: 'question/resolved', sessionId: 's4', questionRpcId: 'rpc-q1', outcome: 'answered' }))
  assert.deepEqual(out.map((e) => [e.t, e.text || e.rpc]), [['q', '发到哪个平台？'], ['qDone', 'rpc-q1']])
})

function fakeSse() {
  const req = new EventEmitter()
  const frames = []
  const res = { writeHead() {}, write(s) { const m = /^data: (.*)\n\n$/s.exec(s); if (m) frames.push(JSON.parse(m[1])) }, end() {} }
  return { req, res, frames }
}

test('reconnect replays missed notices of the same epoch, plus pending asks', () => {
  const h = hub()
  h.started = true // no WebSocket in unit tests
  h.emit({ t: 'done', s: 'a', title: 'A' })
  h.emit({ t: 'done', s: 'b', title: 'B' })
  h.asks.set('ap9', { t: 'ask', s: 'c', id: 'ap9', rpc: 'r9', n: 0 })
  const c = fakeSse()
  h.subscribe(c.req, c.res, { since: 1, epoch: h.epoch, hb: 120 })
  assert.deepEqual(c.frames.map((f) => f.t + (f.s ? ':' + f.s : '')), ['hello', 'done:b', 'ask:c'])
  assert.equal(c.frames[2].replay, true)
  const other = fakeSse()
  h.subscribe(other.req, other.res, { since: 1, epoch: 'old-epoch', hb: 120 })
  assert.deepEqual(other.frames.map((f) => f.t), ['hello', 'ask']) // DSH restarted: nothing to replay
  c.req.emit('close')
  other.req.emit('close')
  assert.equal(h.clients.size, 0)
})

test('settled-while-away approvals are withdrawn after a hub reconnect', () => {
  const h = hub()
  const out = []
  h.emit = ((orig) => (e) => { out.push(orig.call(h, e)); return e })(h.emit)
  h.prevAsks = new Map([['old', { s: 's5', id: 'old' }], ['still', { s: 's5', id: 'still' }]])
  h.prevQs = new Map()
  h.onMux(mux({ type: 'approval/requested', sessionId: 's5', approvalId: 'still', toolName: 'pwsh' }, 'r-still')) // replayed: already known
  h.settleReplay()
  assert.deepEqual(out.map((e) => e.t + ':' + e.id), ['askDone:old'])
})
