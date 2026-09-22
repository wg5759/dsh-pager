import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startDemo } from '../demo/fake-dsh.mjs'
import { foldHistory } from '../fold.js'
import { recentFiles, foldFile } from '../transcripts.js'

const call = async (port, method, payload = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload }) })
  const j = await r.json()
  assert.equal(j.rpcId, 'r1')
  return j.result
}

test('demo DSH: wire protocol, every tool card, waiting approval and question, streamed turn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-demo-'))
  const demo = await startDemo({ root: path.join(root, 'd') })
  try {
    const ws = (await call(demo.port, 'workspace.list')).value
    assert.deepEqual(ws.items.map((w) => w.title), ['shop-web', 'blog'])
    assert.ok(fs.existsSync(path.join(ws.items[0].path, 'src', 'utils', 'csv.js')))
    const list = (await call(demo.port, 'session.list')).value.items
    assert.equal(list.filter((s) => s.running).length, 2)
    const first = list.find((s) => s.projections.values.title.startsWith('首页'))
    const h = foldHistory((await call(demo.port, 'session.history', { sessionId: first.sessionId })).value.events)
    assert.deepEqual([...new Set(h.items.filter((i) => i.k === 't').map((i) => i.kind))].sort(), ['edit', 'execute', 'read', 'search'])
    assert.equal(h.items.at(-1).k, 'end')
    assert.equal((await call(demo.port, 'session.nope')).ok, false)

    // A fresh mux connection gets the waiting approval and question, as DSH does.
    const frames = []
    const mux = new WebSocket(`ws://127.0.0.1:${demo.port}/api/events.mux`)
    mux.onmessage = (m) => frames.push(JSON.parse(m.data))
    await new Promise((r) => { mux.onopen = r })
    await new Promise((r) => setTimeout(r, 200))
    assert.deepEqual(frames.map((f) => f.payload.type).sort(), ['approval/requested', 'question/requested'])

    // A prompt streams a whole turn over the mux.
    assert.equal((await call(demo.port, 'session.prompt', { sessionId: first.sessionId, content: [{ type: 'text', text: '再跑一遍测试' }] })).value.started, true)
    const until = Date.now() + 15000
    while (!frames.some((f) => f.payload.event && f.payload.event.type === 'turn/end') && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
    const types = frames.filter((f) => f.payload.type === 'session/event').map((f) => f.payload.event.type)
    for (const t of ['user/message', 'turn/start', 'assistant/chunk', 'tool/call', 'tool/result', 'assistant/message', 'turn/end']) assert.ok(types.includes(t), t)
    const seqs = frames.filter((f) => f.payload.event).map((f) => f.payload.event.seq)
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b)) // numbering continues the history
    mux.close()

    // Claude Code / Codex session files the plugin can read.
    const files = recentFiles(demo.transcripts)
    assert.deepEqual(files.map((f) => f.src).sort(), ['claude', 'codex'])
    assert.equal(foldFile(files.find((f) => f.src === 'claude').file, 'claude').title, '购物车迁到 Pinia')
  } finally {
    demo.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('demo refuses to wipe a folder it did not create', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-demo-'))
  fs.writeFileSync(path.join(root, 'keep.txt'), 'mine')
  await assert.rejects(startDemo({ root }), /not a demo folder/)
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'mine')
  fs.rmSync(root, { recursive: true, force: true })
})
