/**
 * Phone client (www/app.js) — the two states that used to leave the composer
 * with no working button, verified against the real page script.
 *
 * app.js is a plain browser IIFE with no build step, so it runs here under a
 * minimal DOM/EventSource stub and hands its internals back through the
 * `?debug` hook (`window.__dsh`). That keeps these tests on the shipped code
 * instead of a reimplementation of it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const APP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'www', 'app.js'), 'utf8')

/** Just enough element for app.js's rendering and input paths. */
function makeEl(tag = 'div', id = '') {
  const listeners = {}
  const el = {
    tagName: tag.toUpperCase(), id, children: [], childNodes: [], classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)) }, remove(...c) { c.forEach((x) => this._s.delete(x)) }, toggle(c, on) { if (on === undefined) this._s.has(c) ? this._s.delete(c) : this._s.add(c); else on ? this._s.add(c) : this._s.delete(c) }, contains(c) { return this._s.has(c) } },
    style: {}, dataset: {}, attributes: {}, hidden: false, disabled: false,
    value: '', textContent: '', placeholder: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    innerHTML: '', outerHTML: '', className: '',
    listeners,
    addEventListener(t, fn, o) { (listeners[t] = listeners[t] || []).push({ fn, o }) },
    removeEventListener() {}, dispatch(t, ev = {}) { (listeners[t] || []).forEach((l) => l.fn(ev)) },
    appendChild(c) { el.children.push(c); el.childNodes.push(c); return c },
    insertBefore(c) { el.children.unshift(c); return c },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); return c },
    remove() {}, setAttribute(k, v) { el.attributes[k] = String(v) }, getAttribute(k) { return el.attributes[k] ?? null },
    querySelector() { return null }, querySelectorAll() { return [] }, closest() { return null },
    contains() { return false }, focus() {}, blur() {}, click() {}, scrollIntoView() {}, getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 } },
  }
  // The status pill writes into its own last child; every element carries a
  // plain leaf one so a stub never trips the render path.
  el.firstChild = { textContent: '' }
  el.lastChild = { textContent: '' }
  // app.js also assigns handlers (onclick, oninput, …) and reads elements it
  // never declared. Rather than enumerate every one, unknown properties become
  // absorbent stubs: assignable, and callable when app.js expects a method.
  return new Proxy(el, {
    get(t, k) {
      if (k in t || typeof k === 'symbol') return t[k]
      const stub = () => undefined
      stub.textContent = ''; stub.value = ''; stub.hidden = false
      stub.addEventListener = () => {}; stub.classList = t.classList
      stub.style = {}; stub.dataset = {}
      return (t[k] = stub)
    },
    set(t, k, v) { t[k] = v; return true },
  })
}

/**
 * Boot app.js in a page-shaped sandbox.
 * @param {{search?: string}} opts - `?debug` exposes window.__dsh.
 * @returns the sandbox, with `sandbox.window.__dsh` populated.
 */
function bootApp({ search = '?debug', rpcResult = () => ({ ok: true, value: { accepted: true } }), readResult } = {}) {
  const byId = new Map()
  const store = new Map()
  /** Every /m/api/rpc call the page makes, so tests can assert the wire call. */
  const rpcCalls = []
  const readCalls = []
  const doc = {
    getElementById(id) { if (!byId.has(id)) byId.set(id, makeEl('div', id)); return byId.get(id) },
    createElement(tag) { return makeEl(tag) },
    querySelector() { return null }, querySelectorAll() { return [] },
    addEventListener() {}, removeEventListener() {},
    documentElement: makeEl('html'), head: makeEl('head'), body: makeEl('body'),
    activeElement: null,
  }
  const sandbox = {
    document: doc,
    navigator: { userAgent: 'test', maxTouchPoints: 0, standalone: false, onLine: true, serviceWorker: { register: () => Promise.resolve({}), addEventListener() {} }, vibrate() {} },
    location: { pathname: '/m/', hash: '', search, href: 'https://example.test/m/' + search, replace() {} },
    history: { state: null, pushState() {}, replaceState() {}, go() {}, back() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (t) => clearTimeout(t),
    // The page keeps a reconnect loop and streaming timers alive; a booted
    // sandbox must be inert or the test run never exits. Frame and reconnect
    // timers are driven explicitly by the test through onFrame.
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    // Startup calls fail fast (keeping the sandbox quiet) while RPC posts are
    // recorded, so a test can assert which method the UI actually sent.
    fetch: (url, opts) => {
      if (String(url).indexOf('/m/api/rpc') >= 0 && opts && opts.body) {
        try { rpcCalls.push(JSON.parse(opts.body)) } catch { rpcCalls.push({ raw: opts.body }) }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(rpcResult(rpcCalls.at(-1))), text: () => Promise.resolve('{"ok":true}') })
      }
      if (readResult && String(url).startsWith('/m/api/fs?')) {
        readCalls.push(String(url))
        return Promise.resolve({ status: 200, json: () => Promise.resolve(readResult(String(url))) })
      }
      return Promise.resolve({ ok: false, status: 0, text: () => Promise.resolve(''), json: () => Promise.reject(new Error('offline in tests')) })
    },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Image: class { },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000', getRandomValues: (a) => a },
    EventSource: class { constructor() { this.readyState = 0 } close() {} },
    addEventListener() {}, removeEventListener() {},
    console,
    JSON, Math, Date, Set, Map, Array, Object, String, Number, Boolean, Promise, Error, RegExp, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  vm.createContext(sandbox)
  vm.runInContext(APP, sandbox, { filename: 'app.js' })
  sandbox.rpcCalls = rpcCalls
  sandbox.readCalls = readCalls
  sandbox.els = byId
  return sandbox
}

/** A chat with one queued message, the shape the frame handler builds. */
function chatWithQueue(S, id, running = true) {
  const c = { id, items: [], pending: [], partial: null, lastSeq: -1, firstSeq: -1, hasMore: false, loaded: true, loading: false, err: false, buf: [], open: new Set(), todos: null, todoOpen: false, queue: [], title: '', w: null, model: null, models: null }
  S.chats.set(id, c)
  S.byId[id] = { id, title: 't', at: Date.now(), run: running, w: null }
  if (running) S.run.add(id)
  S.cur = id
  return c
}

test('app.js boots under a bare DOM and exposes the debug hook', () => {
  const sandbox = bootApp()
  assert.ok(sandbox.window.__dsh, '?debug must expose __dsh')
  assert.ok(sandbox.window.__dsh.S, 'debug hook carries the state')
  assert.equal(typeof sandbox.window.__dsh.onFrame, 'function')
  assert.equal(sandbox.window.__dsh.S.cur, null, 'nothing open on a cold start')
})

test('a delivered message retires the queue row that produced it', () => {
  const { S, onFrame } = bootApp().window.__dsh
  const id = 'session-1'
  const c = chatWithQueue(S, id)

  // The phone missed the frame that removed the item, so the row is still here.
  onFrame({ t: 'queue', s: id, items: [{ id: 'm1', place: 'queue', text: '我说的开源项目，不是指开源模型，明白吗？' }] })
  assert.equal(c.queue.length, 1, 'queue frame lands')

  // The request RPC id and the host-generated message id are different.
  onFrame({ t: 'item', s: id, it: { k: 'u', seq: 10, rid: 'request-1', messageId: 'm1', text: '我说的开源项目，不是指开源模型，明白吗？' } })
  assert.deepEqual(c.queue, [], 'the phantom 排队中 row must clear')
})

test('an unrelated queue item is not retired by someone else’s message', () => {
  const { S, onFrame } = bootApp().window.__dsh
  const id = 'session-2'
  const c = chatWithQueue(S, id)
  onFrame({ t: 'queue', s: id, items: [{ id: 'm1', place: 'queue', text: '第一条' }, { id: 'm2', place: 'queue', text: '第二条' }] })
  onFrame({ t: 'item', s: id, it: { k: 'u', seq: 10, rid: 'request-2', messageId: 'm1', text: '第一条' } })
  assert.deepEqual(c.queue.map((x) => x.id), ['m2'], 'only the delivered one goes')
})

test('a queue item with no id is kept (older DSH payloads)', () => {
  const { S, onFrame } = bootApp().window.__dsh
  const id = 'session-3'
  const c = chatWithQueue(S, id)
  onFrame({ t: 'queue', s: id, items: [{ place: 'queue', text: '没有 id' }] })
  onFrame({ t: 'item', s: id, it: { k: 'u', seq: 10, rid: 'whatever', text: 'x' } })
  assert.equal(c.queue.length, 1, 'without an id there is nothing to match on')
})

test('foldHistory stamps the session run state on every end item', async () => {
  const { foldHistory } = await import('../fold.js')
  const entries = [
    { event: { seq: 1, type: 'turn/start', time: 100 } },
    { event: { seq: 2, type: 'turn/end', time: 200, data: { reason: { kind: 'completed' } } } },
  ]
  assert.equal(foldHistory(entries, false).items.at(-1).st, false, 'finished turn')
  assert.equal(foldHistory(entries, true).items.at(-1).st, true, 'a later turn is still running')
  assert.equal(foldHistory(entries).items.at(-1).st, undefined, 'unknown when the caller has no state')
})

// ---------------------------------------------------------------- queue-jump

test('a queued row offers queue-jump while the session is running', () => {
  const sandbox = bootApp()
  const { S, onFrame } = sandbox.window.__dsh
  chatWithQueue(S, 'session-q1')
  onFrame({ t: 'queue', s: 'session-q1', items: [{ id: 'm1', place: 'queue', text: '是要给整个DSH用' }] })
  const html = sandbox.els.get('dock').innerHTML
  assert.match(html, /data-steer="m1"/, 'the row must carry a 插队 button')
  assert.match(html, /data-unqueue="m1"/, 'and still the dismiss button')
  assert.match(html, /插话发送/, 'the button is labelled for assistive tech')
  assert.match(html, /排队中/, 'still shown as queued until the host confirms')
})

test('no queue-jump when the session is idle: there is no turn to steer into', () => {
  const sandbox = bootApp()
  const { S, onFrame } = sandbox.window.__dsh
  chatWithQueue(S, 'session-q2', false)
  onFrame({ t: 'queue', s: 'session-q2', items: [{ id: 'm1', place: 'queue', text: '等待中的消息' }] })
  const html = sandbox.els.get('dock').innerHTML
  assert.doesNotMatch(html, /data-steer/, 'an idle session has nothing to steer into')
  assert.match(html, /data-unqueue="m1"/, 'dismiss stays available')
})

test('“steer all” appears only when more than one row can be steered', () => {
  const sandbox = bootApp()
  const { S, onFrame } = sandbox.window.__dsh
  chatWithQueue(S, 'session-q3')
  onFrame({ t: 'queue', s: 'session-q3', items: [{ id: 'm1', place: 'queue', text: '第一条' }] })
  assert.doesNotMatch(sandbox.els.get('dock').innerHTML, /data-steerall/, 'one row needs no bulk action')
  onFrame({ t: 'queue', s: 'session-q3', items: [{ id: 'm1', place: 'queue', text: '第一条' }, { id: 'm2', place: 'queue', text: '第二条' }] })
  assert.match(sandbox.els.get('dock').innerHTML, /data-steerall/, 'two rows offer the bulk action')
})

test('tapping 插队 sends the host’s strict steer action for that row', async () => {
  const sandbox = bootApp()
  const { S, onFrame } = sandbox.window.__dsh
  const c = chatWithQueue(S, 'session-q4')
  onFrame({ t: 'queue', s: 'session-q4', items: [{ id: 'm1', place: 'queue', text: '是要给整个DSH用' }] })

  sandbox.els.get('dock').dispatch('click', { target: { closest: (sel) => (sel === '[data-steer]' ? { dataset: { steer: 'm1' } } : null) } })
  await new Promise((r) => setImmediate(r))

  const call = sandbox.rpcCalls.find((r) => r.method === 'session.updateQueue')
  assert.ok(call, 'the click must reach the host')
  assert.equal(call.payload.itemId, 'm1')
  assert.equal(call.payload.sessionId, 'session-q4')
  assert.deepEqual(call.payload.action, { kind: 'steer' }, 'steer, not remove')
  assert.equal(c.queue[0].place, 'steering', 'the accepted request waits for actual delivery')
})

test('steer-all steers every still-pending row in FIFO order', async () => {
  const sandbox = bootApp()
  const { S, onFrame } = sandbox.window.__dsh
  chatWithQueue(S, 'session-q5')
  onFrame({ t: 'queue', s: 'session-q5', items: [{ id: 'm1', place: 'queue', text: '甲' }, { id: 'm2', place: 'queue', text: '乙' }, { id: 'm3', place: 'queue', text: '丙' }] })

  sandbox.els.get('dock').dispatch('click', { target: { closest: (sel) => (sel === '[data-steerall]' ? {} : null) } })
  await new Promise((r) => setImmediate(r))

  const ids = sandbox.rpcCalls.filter((r) => r.method === 'session.updateQueue' && r.payload.action.kind === 'steer').map((r) => r.payload.itemId)
  assert.deepEqual(ids, ['m1', 'm2', 'm3'], 'every row, oldest first')
})

test('a steering row does not offer duplicate steering', () => {
  const sandbox = bootApp()
  const { S, onFrame } = sandbox.window.__dsh
  chatWithQueue(S, 'session-q6')
  onFrame({ t: 'queue', s: 'session-q6', items: [{ id: 'm1', place: 'steering', text: '已经在插了' }] })
  const html = sandbox.els.get('dock').innerHTML
  assert.doesNotMatch(html, /data-steer="m1"/, 'the host already accepted steering')
  assert.match(html, /等待接收插话/, 'accepted steering is not claimed as delivered')
})

function tapQueue(sandbox, attr, id) {
  sandbox.els.get('dock').dispatch('click', { target: { closest: (sel) => sel === '[data-' + attr + ']' ? { dataset: { [attr]: id } } : null } })
}

test('queued messages expose edit, delete and steer actions', () => {
  const s = bootApp(), { S, onFrame } = s.window.__dsh
  chatWithQueue(S, 'actions')
  onFrame({ t: 'queue', s: 'actions', items: [{ id: 'm1', place: 'queued', text: '修改这条消息' }] })
  const html = s.els.get('dock').innerHTML
  assert.match(html, /data-qedit="m1"/)
  assert.match(html, /data-unqueue="m1"/)
  assert.match(html, /data-steer="m1"/)
})

test('steering rejection preserves the queued message and shows a useful error', async () => {
  const s = bootApp({ rpcResult: () => ({ ok: false, error: { code: 'steer-unavailable', message: 'No running turn' } }) })
  const { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'rejected')
  onFrame({ t: 'queue', s: c.id, items: [{ id: 'm1', place: 'queued', text: '不能弄丢' }] })
  tapQueue(s, 'steer', 'm1')
  await new Promise(r => setImmediate(r))
  assert.equal(c.queue[0]?.text, '不能弄丢')
  assert.match(s.els.get('toast').textContent, /插话|运行/)
})

test('a pending request keeps its row visible and blocks double taps', async () => {
  let settle
  const s = bootApp({ rpcResult: () => new Promise(r => { settle = r }) })
  const { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'pending')
  onFrame({ t: 'queue', s: c.id, items: [{ id: 'm1', place: 'queued', text: '只发一次' }] })
  tapQueue(s, 'steer', 'm1'); tapQueue(s, 'steer', 'm1')
  await new Promise(r => setImmediate(r))
  assert.equal(c.queue.length, 1)
  assert.equal(s.rpcCalls.length, 1)
  settle({ ok: true, value: { accepted: true } })
  await new Promise(r => setImmediate(r))
})

test('deletion is reconciled from a successful host response without an SSE frame', async () => {
  const s = bootApp(), { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'remove')
  onFrame({ t: 'queue', s: c.id, items: [{ id: 'm1', place: 'queued', text: '撤回' }] })
  tapQueue(s, 'unqueue', 'm1')
  await new Promise(r => setImmediate(r))
  assert.equal(c.queue.length, 0)
  assert.equal(s.rpcCalls[0].payload.action.kind, 'remove')
})

test('editing sends the complete text, including characters beyond the preview limit', async () => {
  const s = bootApp(), { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'edit')
  const full = '长消息'.repeat(150) + '\n尾部不能丢'
  onFrame({ t: 'queue', s: c.id, items: [{ id: 'm1', place: 'queued', text: full.slice(0, 300), editText: full }] })
  tapQueue(s, 'qedit', 'm1')
  const input = s.els.get('qe')
  assert.equal(input.value, full)
  input.value = full + '\n补充'
  const button = { disabled: false }
  s.els.get('sheet').onclick({ target: { closest: sel => sel === '[data-qsave]' ? button : null } })
  await new Promise(r => setImmediate(r))
  assert.deepEqual(s.rpcCalls[0].payload.action, { kind: 'edit', content: [{ type: 'text', text: full + '\n补充' }] })
  assert.equal(c.queue[0].editText, full + '\n补充')
})

test('attachment or legacy clipped rows are never replaced with their preview text', () => {
  for (const editText of [null, undefined]) {
    const s = bootApp(), { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'attachments')
    onFrame({ t: 'queue', s: c.id, items: [{ id: 'm1', place: 'queued', text: '带图的消息', editText }] })
    tapQueue(s, 'qedit', 'm1')
    assert.equal(s.rpcCalls.length, 0)
    assert.match(s.els.get('toast').textContent, /附件|插件/)
  }
})

test('a desktop edit during phone editing is not overwritten silently', async () => {
  const s = bootApp(), { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'conflict')
  onFrame({ t: 'queue', s: c.id, items: [{ id: 'm1', place: 'queued', text: '原文', editText: '原文' }] })
  tapQueue(s, 'qedit', 'm1')
  onFrame({ t: 'queue', s: c.id, items: [{ id: 'm1', place: 'queued', text: '电脑已改', editText: '电脑已改' }] })
  s.els.get('qe').value = '手机改稿'
  s.els.get('sheet').onclick({ target: { closest: sel => sel === '[data-qsave]' ? { disabled: false } : null } })
  assert.equal(s.rpcCalls.length, 0)
  assert.equal(c.queue[0].editText, '电脑已改')
})

test('forbidden and network failures preserve the row and remain visible', async () => {
  for (const code of ['forbidden', 'network-error']) {
    const s = bootApp({ rpcResult: () => ({ ok: false, error: { code, message: code } }) })
    const { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'failure')
    onFrame({ t: 'queue', s: c.id, items: [{ id: 'm1', place: 'queued', text: '保留' }] })
    tapQueue(s, 'unqueue', 'm1')
    await new Promise(r => setImmediate(r))
    assert.equal(c.queue.length, 1)
    assert.match(s.els.get('toast').textContent, /操作未完成/)
  }
})

test('reconnection clears obsolete queue rows even when the host sends no empty baseline', () => {
  const s = bootApp(), { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'reconnect')
  onFrame({ t: 'queue', s: c.id, items: [{ id: 'old', place: 'queued', text: '电脑已删除' }] })
  onFrame({ t: 'hello' })
  assert.equal(c.queue.length, 0)
})

test('queue baselines arrive before history and for chats that have never been opened', () => {
  const s = bootApp(), { S, onFrame } = s.window.__dsh
  onFrame({ t: 'queue', s: 'unopened', items: [{ id: 'm1', place: 'queued', text: '先到的队列', editText: '先到的队列' }] })
  assert.equal(S.chats.get('unopened')?.queue[0].id, 'm1')
  S.chats.get('unopened').loading = true
  onFrame({ t: 'queue', s: 'unopened', items: [] })
  assert.equal(S.chats.get('unopened').queue.length, 0)
})

test('a late edit receipt cannot dismiss a newer editor', async () => {
  let settle, back = 0
  const s = bootApp({ rpcResult: () => new Promise(r => { settle = r }) })
  s.history.back = () => { back++ }
  const { S, onFrame } = s.window.__dsh, c = chatWithQueue(S, 'edit-owner')
  onFrame({ t: 'queue', s: c.id, items: ['m1', 'm2'].map(id => ({ id, place: 'queued', text: id, editText: id })) })
  tapQueue(s, 'qedit', 'm1'); s.els.get('qe').value = 'A的修改'
  s.els.get('sheet').onclick({ target: { closest: sel => sel === '[data-qsave]' ? {} : null } })
  await new Promise(r => setImmediate(r))
  tapQueue(s, 'qedit', 'm2'); s.els.get('qe').value = 'B未保存的草稿'
  settle({ ok: true, value: { accepted: true } })
  await new Promise(r => setImmediate(r))
  assert.equal(back, 0)
  assert.equal(s.els.get('qe').value, 'B未保存的草稿')
})

function resultChat(s, id = 'results', running = false) {
  const { S } = s.window.__dsh, c = chatWithQueue(S, id, running)
  c.w = 'w-results'; S.byId[id].w = c.w
  S.wsById[c.w] = { path: 'D:\\视频项目', title: '视频项目' }
  return c
}
function tapResult(s, selector, dataset) {
  s.els.get('scroller').dispatch('click', { target: { closest: sel => sel === selector ? { dataset } : null }, preventDefault() {} })
}
const rendered = () => new Promise(r => setTimeout(r, 10))

test('completed turns show the final result and keep commentary and tools behind one process', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
  for (const it of [
    { k: 'u', seq: 1, text: '切好视频' },
    { k: 'a', seq: 2, text: '正在分析镜头', think: '内部思考内容' },
    { k: 't', seq: 3, id: 'cut', title: 'ffmpeg 运行细节', detail: '处理日志', done: true },
    { k: 'a', seq: 4, text: '三条切片已完成', think: '最终思考内容' },
    { k: 'end', seq: 5, reason: 'completed' },
  ]) onFrame({ t: 'item', s: c.id, it })
  await rendered()
  let html = s.els.get('msgs').innerHTML
  assert.match(html, /三条切片已完成/)
  assert.equal((html.match(/data-process=/g) || []).length, 1)
  for (const hidden of ['正在分析镜头', 'ffmpeg 运行细节', '内部思考内容', '最终思考内容']) assert.ok(!html.includes(hidden), hidden)
  tapResult(s, '[data-process]', { process: '2' })
  html = s.els.get('msgs').innerHTML
  assert.match(html, /正在分析镜头/)
  assert.match(html, /ffmpeg 运行细节/)
  assert.match(html, /aria-expanded="true"/)
  tapResult(s, '[data-process]', { process: '2' })
  assert.ok(!s.els.get('msgs').innerHTML.includes('正在分析镜头'))
})

test('a live turn keeps streamed commentary compact while approval stays visible', async () => {
  const s = bootApp(), c = resultChat(s, 'live-result', true), { onFrame } = s.window.__dsh
  onFrame({ t: 'd', s: c.id, p: [[1, '不要让我读这段流式分析']] })
  onFrame({ t: 'ask', s: c.id, id: 'confirm', title: '需要用户确认', detail: '保留这项确认' })
  await rendered()
  assert.ok(!s.els.get('tail').innerHTML.includes('不要让我读'))
  assert.match(s.els.get('tail').innerHTML, /运行中/)
  assert.match(s.els.get('dock').innerHTML, /保留这项确认/)
})

test('local video links produce an inline player; Windows, spaces and file URI resolve safely', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
  const text = '[成片](<D:/视频项目/交付/成片 01.mp4>)\n' +
    '`D:\\视频项目\\交付\\说明.md`\n' +
    '[切片](file:///D:/视频项目/交付/切片%2002.mp4)\n' +
    '文件 D:\\视频项目\\交付\\审片.html\n' +
    'https://example.com/video.mp4\n' +
    '`D:\\别的项目\\外部.mp4`\n' +
    '[bad](javascript:alert(1)) <img onerror=alert(1)>\n' +
    '`../outside.mp4`'
  onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text } })
  onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason: 'completed' } })
  await rendered()
  const html = s.els.get('msgs').innerHTML
  assert.equal((html.match(/<video /g) || []).length, 2)
  assert.match(html, /preload="none"/)
  assert.match(html, /data-open-video="D:\/视频项目\/交付\/成片 01.mp4"/)
  assert.match(html, /data-result-path="D:\\视频项目\\交付\\说明.md"/)
  assert.match(html, /data-result-path="D:\\视频项目\\交付\\审片.html"/)
  assert.match(html, /href="https:\/\/example.com\/video.mp4"/)
  assert.ok(!html.includes('data-open-video="D:\\别的项目'))
  assert.ok(!html.includes('data-open-video="../'))
  assert.ok(!html.includes('<img onerror='))
  assert.ok(!html.includes('href="javascript:'))
})

test('a file path opens its parent folder and highlights the delivered file', async () => {
  const s = bootApp({ readResult: url => {
    const p = new URL(url, 'http://test').searchParams.get('path')
    return { ok: true, value: p === '交付/说明.md'
      ? { kind: 'text', rel: '交付/说明.md', name: '说明.md', text: '文件内容', size: 8, at: 0 }
      : { kind: 'dir', rel: '交付', entries: [{ name: '说明.md', dir: false, size: 8, at: 0 }] } }
  } }), c = resultChat(s)
  tapResult(s, '[data-result-path]', { resultPath: '交付/说明.md' })
  await rendered()
  assert.equal(s.readCalls.length, 2)
  assert.equal(new URL(s.readCalls[1], 'http://test').searchParams.get('path'), '交付')
  assert.match(s.els.get('fvBody').innerHTML, /class="row selected"/)
  assert.equal(s.els.get('fvTitle').textContent, '交付')
  assert.ok(!s.els.get('fvBody').innerHTML.includes('文件内容'))
})

test('updating the UI preserves the text draft and current conversation', () => {
  const s = bootApp(), c = resultChat(s), replaces = []
  let reloads = 0
  s.location.reload = () => reloads++
  s.history.replaceState = (...args) => replaces.push(args)
  s.els.get('input').value = '尚未发送的文字'
  s.els.get('status').onclick()
  assert.match(s.els.get('sheet').innerHTML, /更新界面并重连/)
  s.els.get('sheet').onclick({ target: { closest: sel => sel === '[data-a]' ? { dataset: { a: 'reload' } } : null } })
  assert.equal(reloads, 1)
  assert.equal(s.window.__dsh.S.drafts[c.id], '尚未发送的文字')
  assert.equal(replaces.at(-1)[2], '/m/#results')
})

test('UI update waits for pending message operations and unsent images', () => {
  const s = bootApp(), c = resultChat(s)
  let reloads = 0
  s.location.reload = () => reloads++
  s.els.get('status').onclick()
  const update = () => s.els.get('sheet').onclick({ target: { closest: sel => sel === '[data-a]' ? { dataset: { a: 'reload' } } : null } })
  c.queueBusy = { message: true }; update()
  assert.equal(reloads, 0)
  assert.match(s.els.get('toast').textContent, /处理中/)
  c.queueBusy = {}; s.window.__dsh.S.att = [{}]; update()
  assert.equal(reloads, 0)
  assert.match(s.els.get('toast').textContent, /图片/)
})
