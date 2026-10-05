import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { startDemo } from '../demo/fake-dsh.mjs'
import { foldHistory } from '../fold.js'
import { recentFiles, foldFile } from '../transcripts.js'
import { createMobile } from '../server.js'

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
    assert.deepEqual(frames.filter((f) => f.payload.type !== 'session/queue').map((f) => f.payload.type).sort(), ['approval/requested', 'question/requested'])
    const queueBaseline = frames.filter((f) => f.payload.type === 'session/queue').map((f) => f.payload)
    assert.deepEqual(queueBaseline.map((q) => q.sessionId).sort(), list.map((s) => s.sessionId).sort())
    assert.ok(queueBaseline.every((q) => q.items.length === 0))

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

test('demo queue: edit, remove, steer, attachment protection and reconnect snapshots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-queue-'))
  const demo = await startDemo({ root: path.join(root, 'd') })
  let mux
  const queues = new Map()
  const connectMux = async () => {
    mux = new WebSocket(`ws://127.0.0.1:${demo.port}/api/events.mux`)
    mux.onmessage = (m) => {
      const f = JSON.parse(m.data).payload
      if (f.type === 'session/queue') queues.set(f.sessionId, f.items)
    }
    await new Promise((resolve, reject) => { mux.onopen = resolve; mux.onerror = reject })
  }
  const reconnectMux = async () => {
    await new Promise((resolve) => { mux.onclose = resolve; mux.close() })
    queues.clear()
    await connectMux()
  }
  const waitQueue = async (sessionId, ready) => {
    const until = Date.now() + 2000
    while ((!queues.has(sessionId) || !ready(queues.get(sessionId))) && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    const items = queues.get(sessionId) || []
    assert.ok(queues.has(sessionId) && ready(items), 'expected queue broadcast')
    return items
  }
  try {
    await connectMux()
    // Waiting demo turns keep the queue stable without starting a real model or timed reply.
    const [session, attachmentSession] = (await call(demo.port, 'session.list')).value.items.filter((s) => s.running)
    const sessionId = session.sessionId
    const prompt = (content, id = sessionId) => call(demo.port, 'session.prompt', { sessionId: id, content })
    const update = (itemId, action, id = sessionId) => call(demo.port, 'session.updateQueue', { sessionId: id, itemId, action })
    await prompt([{ type: 'text', text: '原始内容' }])
    await prompt([{ type: 'text', text: '保留下一条' }])
    const [first, second] = await waitQueue(sessionId, (q) => q.length === 2)
    assert.equal(first.placement, 'queued')

    const edited = [{ type: 'text', text: '修改后第一行' }, { type: 'text', text: '第二行' }]
    assert.deepEqual((await update(first.id, { kind: 'edit', content: edited })).value, { accepted: true })
    const afterEdit = await waitQueue(sessionId, (q) => q[0]?.text === '修改后第一行\n第二行')
    assert.deepEqual(afterEdit.map((q) => q.id), [first.id, second.id])
    assert.deepEqual(afterEdit[0].message.content, edited)
    assert.deepEqual(afterEdit[1], second)

    const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'demo-image' } }
    assert.equal((await update(first.id, { kind: 'edit', content: [image] })).error.code, 'attachment-error')
    assert.equal((await update(first.id, { kind: 'unknown' })).error.code, 'bad-request')
    assert.deepEqual((await update(second.id, { kind: 'remove' })).value, { accepted: true })
    const afterRemove = await waitQueue(sessionId, (q) => q.length === 1)
    assert.deepEqual(afterRemove[0], afterEdit[0])
    assert.equal((await update(second.id, { kind: 'remove' })).error.code, 'queue-item-not-found')

    assert.deepEqual((await update(first.id, { kind: 'steer' })).value, { accepted: true })
    const afterSteer = await waitQueue(sessionId, (q) => q[0]?.placement === 'steering')
    assert.equal(afterSteer[0].id, first.id)
    assert.deepEqual(afterSteer[0].message.content, edited)
    assert.equal((await update(first.id, { kind: 'steer' })).error.code, 'steer-unavailable')
    assert.equal((await update('already-consumed', { kind: 'steer' })).error.code, 'queue-item-not-found')

    await prompt([{ type: 'text', text: '等待下一轮' }])
    const pending = (await waitQueue(sessionId, (q) => q.length === 2))[1]
    const beforeRefresh = queues.get(sessionId)
    await reconnectMux()
    const restored = await waitQueue(sessionId, (q) => q.length === 2)
    assert.deepEqual(restored, beforeRefresh)
    assert.deepEqual(restored.map((q) => q.placement), ['steering', 'queued'])
    await call(demo.port, 'session.cancel', { sessionId })
    assert.equal((await call(demo.port, 'session.list')).value.items.find((s) => s.sessionId === sessionId).running, false)
    assert.equal((await update(pending.id, { kind: 'steer' })).error.code, 'steer-unavailable')
    assert.deepEqual((await update(first.id, { kind: 'remove' })).value, { accepted: true })
    assert.deepEqual((await update(pending.id, { kind: 'remove' })).value, { accepted: true })
    await waitQueue(sessionId, (q) => q.length === 0)

    const attachedContent = [{ type: 'text', text: '带图排队' }, image]
    await prompt(attachedContent, attachmentSession.sessionId)
    const [attached] = await waitQueue(attachmentSession.sessionId, (q) => q.length === 1)
    assert.deepEqual(attached.message.content, attachedContent)
    assert.equal((await update(attached.id, { kind: 'edit', content: edited }, attachmentSession.sessionId)).error.code, 'attachment-error')
    assert.deepEqual((await update(attached.id, { kind: 'steer' }, attachmentSession.sessionId)).value, { accepted: true })
    const intact = await waitQueue(attachmentSession.sessionId, (q) => q[0]?.placement === 'steering')
    assert.deepEqual(intact[0].message.content, attachedContent)
    assert.deepEqual((await update(attached.id, { kind: 'remove' }, attachmentSession.sessionId)).value, { accepted: true })
    await waitQueue(attachmentSession.sessionId, (q) => q.length === 0)
    await reconnectMux()
    assert.deepEqual(await waitQueue(sessionId, (q) => q.length === 0), [])
    assert.deepEqual(await waitQueue(attachmentSession.sessionId, (q) => q.length === 0), [])
  } finally {
    mux?.close()
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

test('the plugin over the demo DSH: boot, quick commands, usage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-routes-'))
  const demo = await startDemo({ root: path.join(root, 'd') })
  const mobile = createMobile({ apiPort: () => demo.port, pushDir: path.join(root, 'state'), transcripts: demo.transcripts, spawnAgent: demo.spawnAgent })
  const server = http.createServer((req, res) => mobile.handle(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const B = `http://127.0.0.1:${server.address().port}`
  const post = (items) => fetch(B + '/m/api/commands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) })
  try {
    assert.deepEqual((await (await fetch(B + '/m/api/boot')).json()).value.workspaces.map((w) => w.title), ['shop-web', 'blog'])
    const external = (await (await fetch(B + '/m/api/agents')).json()).value
    assert.equal(external.enabled, false)
    assert.deepEqual(external.sessions, [])
    assert.deepEqual(external.asks, [])
    for (const route of ['agents/history?s=agent:codex:fake', 'fs?s=agent:codex:fake&path=README.md', 'raw?s=agent:codex:fake&path=clip.mp4']) {
      const r = await fetch(B + '/m/api/' + route)
      assert.equal(r.status, 403)
      assert.equal((await r.json()).error.code, 'external-agents-disabled')
    }
    for (const route of ['agents/prompt', 'agents/mode', 'respond']) {
      const r = await fetch(B + '/m/api/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ s: 'agent:codex:fake', text: 'x', mode: 'phone', rpcId: 'agent:fake' }) })
      assert.equal(r.status, 403)
    }
    assert.equal((await (await fetch(B + '/m/api/commands')).json()).value.items[0].label, '跑测试')
    const saved = await (await post([{ label: '部署预览', text: '构建并部署到预览环境' }])).json()
    assert.deepEqual(saved.value.items.map((c) => c.label), ['部署预览'])
    assert.deepEqual((await (await fetch(B + '/m/api/commands')).json()).value.items.map((c) => c.text), ['构建并部署到预览环境'])
    assert.ok(fs.existsSync(path.join(root, 'state', 'commands.json')))
    const bad = await post([{ label: '', text: 'x' }])
    assert.equal(bad.status, 400)
    assert.equal((await bad.json()).error.code, 'bad-commands')

    // Usage comes from DSH's per-session projections; boot only carries context pressure from 50%.
    const boot = (await (await fetch(B + '/m/api/boot')).json()).value
    // Real DSH history omits running. Status reconciliation must read list,
    // as this fake host does, rather than inventing a history field.
    for (const s of boot.sessions) {
      const h = (await (await fetch(B + '/m/api/history?s=' + encodeURIComponent(s.id) + '&n=1')).json()).value
      assert.equal(h.run, s.run, s.title)
      for (const end of h.items.filter(it => it.k === 'end')) assert.equal(end.st, s.run)
    }
    // Native video players request byte ranges and HEAD through the same
    // authenticated workspace route used by inline result videos.
    const video = Buffer.from(Array.from({ length: 128 }, (_, i) => i))
    const output = path.join(boot.workspaces[0].path, '成片 01.mp4')
    fs.writeFileSync(output, video)
    const videoInfo = await (await fetch(B + '/m/api/video?s=' + encodeURIComponent(boot.sessions.find(s => s.w === boot.workspaces[0].id).id) + '&path=' + encodeURIComponent('成片 01.mp4'))).json()
    assert.equal(videoInfo.value.state, 'ready')
    assert.ok(videoInfo.value.url.startsWith('/m/api/raw?'))
    const sid = boot.sessions.find(s => s.w === boot.workspaces[0].id).id
    const raw = B + '/m/api/raw?s=' + encodeURIComponent(sid) + '&path=' + encodeURIComponent('成片 01.mp4')
    const ranged = await fetch(raw, { headers: { range: 'bytes=12-23' } })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers.get('content-type'), 'video/mp4')
    assert.equal(ranged.headers.get('content-range'), 'bytes 12-23/128')
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), video.subarray(12, 24))
    const head = await fetch(raw, { method: 'HEAD' })
    assert.equal(head.headers.get('content-length'), '128')
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    assert.equal((await fetch(raw, { headers: { range: 'bytes=200-' } })).status, 416)
    const denied = await fetch(B + '/m/api/raw?s=' + encodeURIComponent(sid) + '&path=' + encodeURIComponent('../outside.mp4'))
    assert.ok([403, 404].includes(denied.status))
    const rss = boot.sessions.find((x) => x.title.startsWith('RSS'))
    assert.equal(rss.cx, 74)
    assert.equal(boot.sessions.find((x) => x.title.startsWith('首页')).cx, undefined)
    const one = (await (await fetch(B + '/m/api/usage?s=' + encodeURIComponent(rss.id))).json()).value
    assert.deepEqual([one.sessions.length, one.sessions[0].u.ctxPct, one.sessions[0].u.out, one.sessions[0].u.turns], [1, 74, 9800, 9])
    const week = (await (await fetch(B + '/m/api/usage?days=7')).json()).value
    assert.equal(week.days, 7)
    assert.equal(week.totals.sessions, 5)
    assert.equal(week.totals.out, 3200 + 9800 + 900 + 2100 + 600)
    assert.equal(week.sessions[0].title, 'RSS 日期早了 8 小时') // the biggest first
    // Existing desktop hooks are handed back immediately, never held for a
    // phone decision when external-agent sharing is off.
    for (let i = 0; i < 40 && !fs.existsSync(path.join(root, 'state', 'hook.json')); i++) await new Promise(r => setTimeout(r, 100))
    const token = JSON.parse(fs.readFileSync(path.join(root, 'state', 'hook.json'), 'utf8')).token
    const response = await fetch(B + '/m/api/agents/hook?src=codex', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pager-token': token }, body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'external-task', cwd: root }) })
    assert.deepEqual(await response.json(), {})
  } finally {
    server.close()
    mobile.close()
    demo.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('external-agent sharing requires explicit opt-in', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-optin-'))
  const demo = await startDemo({ root: path.join(root, 'd') })
  const mobile = createMobile({ apiPort: () => demo.port, pushDir: path.join(root, 'state'), transcripts: demo.transcripts, externalAgents: true })
  const server = http.createServer((req, res) => mobile.handle(req, res))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const result = await (await fetch(`http://127.0.0.1:${server.address().port}/m/api/agents`)).json()
    assert.ok(result.ok, JSON.stringify(result.error))
    assert.equal(result.value.enabled, true)
    assert.equal(result.value.sessions.length, 2)
  } finally { server.close(); mobile.close(); demo.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
