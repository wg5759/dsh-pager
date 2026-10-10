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

// Controlled DOMParser documents: structural whitespace is separate from
// inline source text, as in a real parsed document. Browser acceptance is separate.
const UI_DOCUMENTS = new Map()
function uiShell({ css = 'body { color: black; }', js = 'window.fixture = 1;', content = '', title = 'DSH', marker = true } = {}) {
  const core = '<html><head><title>' + title + '</title><link rel="manifest" href="/m/manifest.webmanifest"><style>' + css + '</style></head><body><div id="' + (marker ? 'app' : 'gateway') + '"><section id="home"><div id="rows"></div></section><section id="chat"><div id="msgs"></div><textarea id="input"></textarea><button id="send"></button></section>' + content + '</div><script>' + js + '</script>'
  const fixture = { core, title, marker, css, js, snapshot: core + '</body></html>', html: '<!doctype html>\n' + core + '\n</body>\n</html>' }
  UI_DOCUMENTS.set(fixture.snapshot, { fixture, tail: '' })
  UI_DOCUMENTS.set(fixture.html, { fixture, tail: '\n' })
  return fixture
}
const UI_BASE = uiShell(), UI_NEW = uiShell({ css: 'body { color: blue; }' })
function parsedShell(source) {
  const { fixture, tail } = UI_DOCUMENTS.get(source) || { fixture: { core: '<html><head></head><body>invalid', title: '', marker: false, css: '', js: '' }, tail: '' }
  const container = (children) => ({ childNodes: children, removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1) } })
  const body = container(tail ? [{ nodeType: 1 }, { nodeType: 3, nodeValue: tail }] : [{ nodeType: 1 }])
  const head = container([{ nodeType: 1 }]), documentElement = container([head, body])
  head.nodeType = body.nodeType = 1
  Object.defineProperty(documentElement, 'outerHTML', { get: () => fixture.core + body.childNodes.filter(n => n.nodeType === 3).map(n => n.nodeValue).join('') + '</body></html>' })
  return { title: fixture.title, head, body, documentElement,
    querySelectorAll: selector => selector === '#app' && fixture.marker ? [{}] : [],
    querySelector(selector) {
      if (!fixture.marker) return null
      if (selector === 'link[rel="manifest"]') return { getAttribute: name => name === 'href' ? '/m/manifest.webmanifest' : null }
      if (selector === 'head > style') return { textContent: fixture.css }
      if (selector === 'body > script') return { textContent: fixture.js, getAttribute: () => null }
      return ['#app > section#home #rows', '#app > section#chat #msgs', '#app > section#chat textarea#input', '#app > section#chat button#send'].includes(selector) ? {} : null
    },
  }
}
const shellResponse = (fixture = UI_BASE, etag = '"base"', status = 200, type = 'text/html; charset=utf-8') => ({ status,
  headers: { get: name => ({ etag, 'content-type': type })[name.toLowerCase()] ?? null }, text: () => Promise.resolve(fixture.html),
})

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
function bootApp({ search = '?debug', rpcResult = () => ({ ok: true, value: { accepted: true } }), readResult, agentsResult, loadedHtml = UI_BASE.snapshot, liveHtml, uiResult, appLatestResult, userAgent = 'test', visibility = 'visible', online = true } = {}) {
  const byId = new Map()
  const store = new Map()
  /** Every /m/api/rpc call the page makes, so tests can assert the wire call. */
  const rpcCalls = []
  const readCalls = []
  const uiCalls = [], headCalls = [], uiGetCalls = [], parseCalls = [], appLatestCalls = [], intervals = [], timeouts = new Map()
  let now = Date.now(), timerId = 0, reloads = 0
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } }
  const windowEvents = new Map(), documentEvents = new Map()
  const doc = {
    getElementById(id) { if (!byId.has(id)) byId.set(id, makeEl('div', id)); return byId.get(id) },
    createElement(tag) { return makeEl(tag) },
    querySelector() { return null }, querySelectorAll(selector) { if (selector === '[data-ic]' && liveHtml) doc.documentElement.outerHTML = liveHtml; return [] },
    addEventListener(t, fn) { if (!documentEvents.has(t)) documentEvents.set(t, []); documentEvents.get(t).push(fn) }, removeEventListener() {},
    documentElement: makeEl('html'), head: makeEl('head'), body: makeEl('body'),
    activeElement: null, visibilityState: visibility,
  }
  doc.documentElement.outerHTML = loadedHtml
  const sandbox = {
    document: doc,
    navigator: { userAgent, maxTouchPoints: 0, standalone: false, onLine: online, serviceWorker: { register: () => Promise.resolve({}), addEventListener() {} }, vibrate() {} },
    location: { pathname: '/m/', hash: '', search, href: 'https://example.test/m/' + search, replace() {}, reload() { reloads++ } },
    history: { state: null, pushState() {}, replaceState() {}, go() {}, back() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (t) => clearTimeout(t),
    // The page keeps a reconnect loop and streaming timers alive; a booted
    // sandbox must be inert or the test run never exits. Frame and reconnect
    // timers are driven explicitly by the test through onFrame.
    setTimeout(fn, ms) { timeouts.set(++timerId, { fn, ms }); return timerId }, clearTimeout(id) { timeouts.delete(id) },
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length }, clearInterval() {},
    // Startup calls fail fast (keeping the sandbox quiet) while RPC posts are
    // recorded, so a test can assert which method the UI actually sent.
    fetch: (url, opts) => {
      if (String(url) === '/m/') {
        const call = { url: String(url), opts }
        uiCalls.push(call); (opts.method === 'HEAD' ? headCalls : uiGetCalls).push(call)
        return Promise.resolve().then(() => uiResult ? uiResult(call) : shellResponse())
      }
      if (String(url) === '/m/api/app/latest') {
        appLatestCalls.push({ url: String(url), opts })
        return Promise.resolve().then(() => appLatestResult ? appLatestResult(appLatestCalls.at(-1)) : { status: 200, json: () => Promise.resolve({ ok: true, value: { versionName: '1.3.2', versionCode: 132 } }) })
      }
      if (String(url) === '/m/api/agents' && agentsResult) return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, value: agentsResult }) })
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
    DOMParser: class { parseFromString(source, type) { parseCalls.push({ source, type }); assert.equal(type, 'text/html'); return parsedShell(source) } },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000', getRandomValues: (a) => a },
    EventSource: class { constructor() { this.readyState = 0 } close() {} },
    addEventListener(t, fn) { if (!windowEvents.has(t)) windowEvents.set(t, []); windowEvents.get(t).push(fn) }, removeEventListener() {},
    console,
    JSON, Math, Date: Clock, Set, Map, Array, Object, String, Number, Boolean, Promise, Error, RegExp, AbortController, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  vm.createContext(sandbox)
  vm.runInContext(APP, sandbox, { filename: 'app.js' })
  sandbox.rpcCalls = rpcCalls
  sandbox.readCalls = readCalls
  sandbox.els = byId
  sandbox.dispatchWindow = (t, event) => (windowEvents.get(t) || []).forEach(fn => fn(event))
  sandbox.dispatchDocument = (t, event) => (documentEvents.get(t) || []).forEach(fn => fn(event))
  sandbox.uiCalls = uiCalls; sandbox.headCalls = headCalls; sandbox.uiGetCalls = uiGetCalls; sandbox.parseCalls = parseCalls; sandbox.appLatestCalls = appLatestCalls
  sandbox.advance = (ms) => { now += ms }
  sandbox.runInterval = (ms) => intervals.filter(timer => timer.ms === ms).forEach(timer => timer.fn())
  sandbox.fireTimeouts = (ms) => { for (const [id, timer] of timeouts) if (timer.ms === ms) { timeouts.delete(id); timer.fn() } }
  sandbox.reloadCount = () => reloads
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

const latestResponse = () => ({ status: 200, json: () => Promise.resolve({ ok: true, value: { versionName: '1.4.0', versionCode: 140 } }) })
const tapUiUpdate = s => s.els.get('rows').dispatch('click', { target: { closest: selector => selector === '[data-ui-update]' ? {} : null } })

for (const [kind, remote] of [['CSS', UI_NEW], ['JS', uiShell({ js: 'window.fixture = 2;' })], ['HTML', uiShell({ content: '<aside>new content</aside>' })]]) {
  test(`existing-server ${kind} changes are discovered without a revision meta or custom header`, async () => {
    const s = bootApp({ uiResult: () => shellResponse(remote, '"new"') })
    s.window.__dsh.S.booted = true
    await rendered()
    assert.equal(s.uiGetCalls.length, 1)
    assert.equal(s.headCalls.length, 0, 'startup compares HTML before using HEAD shortcuts')
    assert.equal(s.uiGetCalls[0].opts.method, 'GET')
    assert.equal(s.uiGetCalls[0].opts.cache, 'no-store')
    assert.equal(s.uiGetCalls[0].opts.redirect, 'manual')
    assert.equal(s.window.__dsh.S.uiUpdate, true)
    assert.match(s.els.get('rows').innerHTML, /界面有更新，点这里更新/)
    assert.equal(s.appLatestCalls.length, 0)
    assert.equal(s.reloadCount(), 0)
  })
}

test('HTML comparison normalizes parser-tail whitespace and keeps the pre-mutation loaded snapshot', async () => {
  const live = uiShell({ content: '<p>runtime conversation DOM</p>' })
  const s = bootApp({ liveHtml: live.snapshot })
  await rendered()
  assert.equal(s.uiGetCalls.length, 1)
  assert.ok(!s.window.__dsh.S.uiUpdate, 'identical shell with parser-added tail whitespace is not an update')
  assert.equal(s.document.documentElement.outerHTML, live.snapshot)
  assert.ok(s.parseCalls.some(call => call.source === UI_BASE.snapshot), 'normalization uses the snapshot captured before page mutations')
  assert.ok(!s.parseCalls.some(call => call.source === live.snapshot), 'runtime DOM must never become the loaded baseline')
})

test('unchanged ETag costs only HEAD and changed ETag compares GET HTML using the GET response ETag', async () => {
  let etag = '"base"'
  const s = bootApp({ uiResult: ({ opts }) => shellResponse(UI_BASE, opts.method === 'GET' && etag === '"head-B"' ? '"get-C"' : etag) })
  await rendered()
  s.advance(60000); s.runInterval(60000); await rendered()
  assert.equal(s.headCalls.length, 1); assert.equal(s.uiGetCalls.length, 1)
  etag = '"head-B"'; s.advance(60000); s.dispatchWindow('online'); await rendered()
  assert.equal(s.uiGetCalls.length, 2)
  assert.ok(!s.window.__dsh.S.uiUpdate, 'ETag alone does not prove different normalized HTML')
  etag = '"get-C"'; s.advance(60000); s.dispatchWindow('online'); await rendered()
  assert.equal(s.headCalls.length, 3); assert.equal(s.uiGetCalls.length, 2, 'remember the GET ETag, not the earlier HEAD ETag')
})

test('login, gateway, wrong MIME and invalid shell responses neither raise nor clear UI reminders', async () => {
  const invalid = [shellResponse(UI_NEW, '"bad"', 401), { status: 0, type: 'opaqueredirect' }, shellResponse(UI_NEW, '"bad"', 503),
    shellResponse(UI_NEW, '"bad"', 200, 'text/plain'), shellResponse(uiShell({ title: 'Login' }), '"bad"'), shellResponse(uiShell({ marker: false }), '"bad"')]
  for (const reply of invalid) {
    const s = bootApp({ uiResult: () => reply })
    await rendered(); assert.ok(!s.window.__dsh.S.uiUpdate); assert.equal(s.reloadCount(), 0)
  }
  let reply = shellResponse(UI_NEW, '"new"')
  const s = bootApp({ uiResult: () => reply })
  await rendered()
  const toast = s.els.get('toast').textContent, status = s.window.__dsh.S.status
  for (const failure of invalid) {
    reply = failure; s.advance(60000); s.dispatchWindow('online'); await rendered()
    assert.equal(s.window.__dsh.S.uiUpdate, true)
    assert.equal(s.els.get('toast').textContent, toast); assert.equal(s.window.__dsh.S.status, status); assert.equal(s.reloadCount(), 0)
  }
  reply = shellResponse(UI_BASE, '"bad"'); s.advance(60000); s.dispatchWindow('online'); await rendered()
  assert.equal(s.window.__dsh.S.uiUpdate, null, 'failed GETs did not commit the observed HEAD ETag; the same ETag can be retried')
})

test('UI and APK failures recover together and keep distinct home actions', async () => {
  let fail = true
  const s = bootApp({ userAgent: 'DSHApp/1.3.2+132', uiResult: () => fail ? Promise.reject(new Error('offline')) : shellResponse(UI_NEW, '"new"'),
    appLatestResult: () => fail ? Promise.reject(new Error('offline')) : latestResponse() })
  s.window.__dsh.S.booted = true
  await rendered()
  assert.equal(s.uiGetCalls.length, 1); assert.equal(s.appLatestCalls.length, 1)
  fail = false; s.advance(60000); s.dispatchWindow('online'); await rendered()
  assert.equal(s.uiGetCalls.length, 2); assert.equal(s.appLatestCalls.length, 2)
  assert.equal(s.window.__dsh.S.uiUpdate, true)
  assert.equal(s.window.__dsh.S.appUpdate.versionName, '1.4.0')
  assert.match(s.els.get('rows').innerHTML, /界面有更新，点这里更新/)
  assert.match(s.els.get('rows').innerHTML, /App 安装包有新版本/)
  assert.equal(s.reloadCount(), 0); assert.ok(!s.location.href.startsWith('dshapp:'))
})

test('HTML probes share in-flight work across lifecycle events and one 60 second throttle', async () => {
  let first
  const s = bootApp({ uiResult: ({ opts }) => opts.method === 'GET' ? new Promise(resolve => { first = resolve }) : shellResponse() })
  await rendered(); s.advance(120000)
  s.dispatchWindow('online'); s.dispatchDocument('visibilitychange'); s.runInterval(60000)
  assert.equal(s.uiCalls.length, 1, 'a slow request crossing the throttle window still cannot overlap')
  first(shellResponse()); await rendered()
  s.dispatchWindow('online'); s.dispatchDocument('visibilitychange'); s.runInterval(60000); await rendered()
  assert.equal(s.uiCalls.length, 2)
  s.advance(59999); s.dispatchWindow('online'); s.runInterval(60000); assert.equal(s.uiCalls.length, 2)
  s.advance(1); s.runInterval(60000); await rendered()
  assert.equal(s.uiCalls.length, 3); assert.equal(s.uiGetCalls.length, 1)
})

test('HTML and APK update checks wait while hidden or offline and resume visibly online', async () => {
  for (const initial of [{ visibility: 'hidden' }, { online: false }]) {
    const s = bootApp({ ...initial, userAgent: 'DSHApp/1.3.2+132', uiResult: () => shellResponse(UI_NEW, '"new"') })
    await rendered(); s.dispatchWindow('online'); s.runInterval(60000); await rendered()
    assert.equal(s.uiCalls.length, 0); assert.equal(s.appLatestCalls.length, 0)
    s.document.visibilityState = 'visible'; s.navigator.onLine = true
    s.dispatchDocument('visibilitychange'); await rendered()
    assert.equal(s.uiGetCalls.length, 1); assert.equal(s.appLatestCalls.length, 1)
  }
})

test('rollback to the fixed loaded HTML clears the reminder but errors retain it and unchanged state does not repaint', async () => {
  let reply = shellResponse(UI_NEW, '"new"')
  const s = bootApp({ uiResult: () => reply }); const S = s.window.__dsh.S
  S.booted = true; await rendered(); assert.equal(S.uiUpdate, true)
  reply = shellResponse(UI_BASE, '"rollback"'); s.advance(60000); s.dispatchWindow('online'); await rendered()
  assert.equal(S.uiUpdate, null); assert.ok(!s.els.get('rows').innerHTML.includes('data-ui-update'))
  let html = s.els.get('rows').innerHTML, writes = 0
  Object.defineProperty(s.els.get('rows'), 'innerHTML', { configurable: true, get: () => html, set(value) { html = value; writes++ } })
  s.advance(60000); s.dispatchWindow('online'); await rendered(); assert.equal(writes, 0)
  reply = shellResponse(UI_NEW, '"new-again"'); s.advance(60000); s.dispatchWindow('online'); await rendered()
  assert.equal(S.uiUpdate, true, 'the baseline was not replaced by a previously fetched new shell'); assert.equal(writes, 1)
  s.advance(60000); s.dispatchWindow('online'); await rendered(); assert.equal(writes, 1); assert.equal(s.reloadCount(), 0)
})

test('the home UI update action reuses draft, pending queue and unsent-image reload protection', async () => {
  const s = bootApp({ uiResult: () => shellResponse(UI_NEW, '"new"') }), c = resultChat(s)
  const S = s.window.__dsh.S, replaces = []
  s.history.replaceState = (...args) => replaces.push(args)
  s.els.get('input').value = '返回首页前未发送的草稿'; s.dispatchWindow('popstate', { state: { v: 'home' } })
  S.booted = true; await rendered(); assert.equal(S.cur, null); assert.equal(S.drafts[c.id], '返回首页前未发送的草稿')
  c.queueBusy = { m1: true }; tapUiUpdate(s); assert.equal(s.reloadCount(), 0); assert.match(s.els.get('toast').textContent, /处理中/)
  c.queueBusy = {}; S.att = [{}]; tapUiUpdate(s); assert.equal(s.reloadCount(), 0); assert.match(s.els.get('toast').textContent, /图片/)
  S.att = []; tapUiUpdate(s); assert.equal(s.reloadCount(), 1)
  assert.equal(S.drafts[c.id], '返回首页前未发送的草稿'); assert.equal(replaces.at(-1)[2], '/m/')
})

test('a changed HTML response during playback leaves the actual message player and conversation untouched', async () => {
  let reply
  const s = bootApp({ uiResult: () => new Promise(resolve => { reply = resolve }) }), c = resultChat(s), dom = installVideoDom(s)
  twoVideoTurns(s, c, s.window.__dsh.onFrame); await rendered()
  const v = dom.videos()[1]
  v.currentTime = 8.3; v.paused = false; v._fullscreen = true; v.src = '/unchanged-player'; v.dataset.quality = 'original'
  assert.equal(typeof reply, 'function', 'the initial HTML comparison requested the existing resource')
  reply(shellResponse(UI_NEW, '"new"')); await rendered()
  assert.equal(s.window.__dsh.S.uiUpdate, true); assert.equal(dom.videos()[1], v)
  assert.equal(v.currentTime, 8.3); assert.equal(v.paused, false); assert.equal(v._fullscreen, true)
  assert.equal(v.src, '/unchanged-player'); assert.equal(v.dataset.quality, 'original'); assert.equal(v.playCalls, 0)
  assert.equal(s.window.__dsh.S.cur, c.id); assert.equal(s.reloadCount(), 0)
})

test('a timed out HTML probe releases its gate for the next bounded check', async () => {
  let attempts = 0
  const s = bootApp({ uiResult: ({ opts }) => ++attempts === 1
    ? new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))) : shellResponse(UI_NEW, '"new"') })
  await rendered(); assert.equal(s.uiGetCalls.length, 1)
  s.fireTimeouts(8000); await rendered(); assert.equal(s.uiGetCalls[0].opts.signal.aborted, true)
  s.advance(60000); s.dispatchWindow('online'); await rendered()
  assert.equal(s.uiGetCalls.length, 2); assert.equal(s.window.__dsh.S.uiUpdate, true); assert.equal(s.reloadCount(), 0)
})

test('missing ETag keeps comparison available instead of becoming an update marker', async () => {
  let remote = UI_BASE
  const s = bootApp({ uiResult: () => shellResponse(remote, null) })
  await rendered(); assert.ok(!s.window.__dsh.S.uiUpdate)
  remote = UI_NEW; s.advance(60000); s.dispatchWindow('online'); await rendered()
  assert.equal(s.headCalls.length, 1); assert.equal(s.uiGetCalls.length, 2)
  assert.equal(s.window.__dsh.S.uiUpdate, true)
})

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

test('a long completed result folds details but keeps videos and file cards outside', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
  const text = '成片已完成 <检查>。\n\n' + '详细检查说明'.repeat(105) + '\n\n' +
    '[成片](<D:/视频项目/交付/成片 01.mp4>)\n' +
    '[同一成片](<D:/视频项目/交付/成片 01.mp4>)\n' +
    '`D:\\视频项目\\交付\\说明.md`\n`D:\\别的项目\\外部.md`'
  onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text } })
  onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason: 'completed' } })
  await rendered()
  const html = s.els.get('msgs').innerHTML
  assert.match(html, /class="result-excerpt">成片已完成 &lt;检查&gt;。<\/div>/)
  assert.match(html, /<details class="result-details" data-result-details="1"><summary>查看完整结果<\/summary>/)
  assert.match(html.slice(html.indexOf('<details'), html.indexOf('</details>')), /详细检查说明/)
  const visibleCards = html.slice(html.indexOf('</details>') + '</details>'.length)
  assert.equal((visibleCards.match(/<video /g) || []).length, 1, 'deduplicated existing path registry')
  assert.match(visibleCards, /data-result-path="D:\\视频项目\\交付\\说明.md"/)
  assert.ok(!visibleCards.includes('别的项目'))
  assert.equal(s.rpcCalls.length, 0)
})

test('line-heavy completed results fold; short, failed and interrupted answers stay open', async () => {
  for (const [reason, text, folded] of [
    ['completed', Array.from({ length: 13 }, (_, i) => '检查项 ' + i).join('\n'), true],
    ['completed', '两条视频已完成。', false],
    ['failed', '错误细节'.repeat(160), false],
    ['interrupted', '未完成事项'.repeat(160), false],
  ]) {
    const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
    onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text } })
    onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason } })
    await rendered()
    assert.equal(s.els.get('msgs').innerHTML.includes('data-result-details'), folded, reason)
  }
})

test('native result toggle saves state without rendering and copying still returns all text', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
  const text = '切片已完成。\n\n' + '完整内容'.repeat(160)
  for (const it of [
    { k: 'a', seq: 1, text: '处理过程' },
    { k: 'a', seq: 2, text },
    { k: 'end', seq: 3, reason: 'completed' },
  ]) onFrame({ t: 'item', s: c.id, it })
  await rendered()
  const msgs = s.els.get('msgs'), toggle = msgs.listeners.toggle[0]
  assert.equal(toggle.o, true, 'native toggle is captured')
  const untouched = msgs.innerHTML
  msgs.dispatch('toggle', { target: { tagName: 'DETAILS', dataset: { resultDetails: '2' }, open: true } })
  assert.equal(msgs.innerHTML, untouched, 'toggle must not replace the DOM containing players')
  assert.ok(c.resultOpen.has(2))
  tapResult(s, '[data-process]', { process: '1' })
  assert.match(msgs.innerHTML, /data-result-details="2" open>/, 'unrelated redraw restores expansion')
  const expanded = msgs.innerHTML
  msgs.dispatch('toggle', { target: { tagName: 'DETAILS', dataset: { resultDetails: '2' }, open: false } })
  assert.equal(msgs.innerHTML, expanded)
  assert.ok(!c.resultOpen.has(2))
  tapResult(s, '[data-process]', { process: '1' })
  assert.match(msgs.innerHTML, /data-result-details="2">/)
  let copied
  s.navigator.clipboard = { writeText: value => { copied = value; return Promise.resolve() } }
  tapResult(s, '[data-copymsg]', { copymsg: '2' })
  assert.equal(copied, text)
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

test('result paths reject commands, domains and slash prose while keeping explicit files and directories', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
  const noise = ['begin.py --help', 'cp.kuaishou.com', 'cp.kuaishou.com/upload.mp4', 'acquire',
    'acquire/preflight.py/原生检查', '下载/预览', '3/≤3', '≤3', '3', '不存在假文本', 'python tools/preflight.py',
    'D:/视频项目/tools/preflight.py acquire', 'tools/preflight.py acquire']
  const text = '这是路径识别检查。\n\n' + noise.map(x => '`' + x + '`').join('\n') + '\n' +
    '普通文本 acquire/preflight.py/原生检查\n普通命令 python tools/preflight.py\n相对命令 tools/begin.py --help\n无参数名命令 tools/preflight.py acquire\n' +
    '[相对文件](delivery/说明.md)\n[目录](delivery/)\n[证据目录](evidence/Bjoint/)\n[明确目录](./Bjoint)\n' +
    '[安装包](delivery/DSH.apk)\n[文档](delivery/审片.pdf)\n' +
    '[中文视频](<D:/视频项目/交付/真实 成片.mp4>)\n' +
    '[工作区外](<D:/别的项目/不可访问.mp4>)\n' +
    '[bad](javascript:alert(1)) <img onerror=alert(1)>'
  onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text } })
  onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason: 'completed' } })
  await rendered()
  const html = s.els.get('msgs').innerHTML
  const paths = [...html.matchAll(/data-(?:result-path|open-video|artifact)="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual([...new Set(paths)].sort(), ['delivery/说明.md', 'delivery/', 'evidence/Bjoint/', './Bjoint', 'delivery/DSH.apk', 'delivery/审片.pdf', 'D:/视频项目/交付/真实 成片.mp4'].sort())
  for (const n of noise) assert.ok(html.includes(n), 'unrecognized expressions remain text: ' + n)
  assert.ok(!html.includes('<img onerror='))
  assert.ok(!html.includes('href="javascript:'))
  assert.equal(s.readCalls.length, 0, 'recognition does not probe filesystem per log token')
  assert.equal(s.rpcCalls.length, 0)
})

test('one message deduplicates Windows slash, case and workspace-relative video paths', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
  const text = '[A](<D:/视频项目/交付/成片 01.mp4>)\n' +
    '[B](<d:\\视频项目\\交付\\成片 01.MP4>)\n' +
    '[C](<交付/成片 01.mp4>)\n[同一文件](<./交付/成片 01.mp4>)\n' +
    '[说明一](<D:/视频项目/交付/说明.md>)\n[说明二](<交付\\说明.MD>)\n\n' + '详细说明'.repeat(160)
  onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text } })
  onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason: 'completed' } })
  await rendered()
  const html = s.els.get('msgs').innerHTML
  assert.equal((html.match(/<video /g) || []).length, 1)
  assert.equal((html.match(/class="artifact artifact-file"/g) || []).length, 1)
  const links = [...html.matchAll(/data-open-video="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual([...new Set(links)], ['D:/视频项目/交付/成片 01.mp4'], 'all aliases target the first registered player')
})

test('POSIX result path deduplication preserves case-sensitive filenames', async () => {
  const s = bootApp(), c = resultChat(s), { S, onFrame } = s.window.__dsh
  S.wsById[c.w].path = '/workspace/video'
  const text = '[大写文件](/workspace/video/delivery/A.mp4)\n' +
    '[小写文件](delivery/a.mp4)\n[大写别名](./delivery/A.mp4)'
  onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text } })
  onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason: 'completed' } })
  await rendered()
  const html = s.els.get('msgs').innerHTML
  assert.equal((html.match(/<video /g) || []).length, 2)
  const links = [...html.matchAll(/data-open-video="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual([...new Set(links)], ['/workspace/video/delivery/A.mp4', 'delivery/a.mp4'])
})

test('a code basename is text beside the delivered absolute path, not a second root file', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
  const text = '成片 `clip-B-craft-answer-v4.mp4`\n' +
    '[成片路径](<D:/视频项目/_验收/delivery/clip-B-craft-answer-v4.mp4>)\n' +
    '`py.exe` 和 `manifest.json` 只是文件名说明。\n\n' + '详细说明'.repeat(160)
  onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text } })
  onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason: 'completed' } })
  await rendered()
  const html = s.els.get('msgs').innerHTML
  assert.match(html, /<code>clip-B-craft-answer-v4.mp4<\/code>/)
  assert.match(html, /<code>py.exe<\/code>/)
  assert.match(html, /<code>manifest.json<\/code>/)
  assert.equal((html.match(/<video /g) || []).length, 1)
  assert.equal((html.match(/class="artifact artifact-file"/g) || []).length, 0)
  assert.equal(s.readCalls.length, 0)
})

test('explicit Markdown root filenames work and same basenames in distinct paths stay distinct', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh
  const text = '[根内目标](clip.mp4)\n[另一目录](delivery/clip.mp4)\n' +
    '[同一根内目标](<D:/视频项目/clip.mp4>)\n[说明](report.json)'
  onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text } })
  onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason: 'completed' } })
  await rendered()
  const html = s.els.get('msgs').innerHTML
  assert.equal((html.match(/<video /g) || []).length, 2)
  assert.match(html, /data-open-video="clip.mp4"/)
  assert.match(html, /data-open-video="delivery\/clip.mp4"/)
  assert.match(html, /data-result-path="report.json"/)
})

test('explicit directory clicks remain supported and missing paths are only checked on demand', async () => {
  const s = bootApp({ readResult: url => {
    const p = new URL(url, 'http://test').searchParams.get('path')
    return p === 'delivery/'
      ? { ok: true, value: { kind: 'dir', rel: 'delivery', entries: [] } }
      : { ok: false, error: { message: '文件不存在' } }
  } }), c = resultChat(s), { onFrame } = s.window.__dsh
  onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 1, text: '[目录](delivery/)\n[未核验文件](delivery/missing.md)' } })
  onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 2, reason: 'completed' } })
  await rendered()
  assert.equal(s.readCalls.length, 0)
  tapResult(s, '[data-result-path]', { resultPath: 'delivery/' })
  await rendered()
  assert.match(s.els.get('fvBody').innerHTML, /空文件夹/)
  tapResult(s, '[data-result-path]', { resultPath: 'delivery/missing.md' })
  await rendered()
  assert.match(s.els.get('fvBody').innerHTML, /打不开/)
  assert.match(s.els.get('fvBody').innerHTML, /文件不存在/)
  assert.equal(s.readCalls.length, 2)
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

test('DSH-only mode clears stale external records and prompts while preserving native ones', async () => {
  const s = bootApp({ agentsResult: { enabled: false, mode: 'pc', sessions: [], asks: [] } })
  const { S, onFrame } = s.window.__dsh
  const external = chatWithQueue(S, 'agent:codex:old')
  external.items = [{ k: 'a', seq: 1, text: 'old external record' }]
  S.chats.set('native', { id: 'native' })
  S.asks.set('external', { s: external.id }); S.asks.set('native', { s: 'native' })
  onFrame({ t: 'hello' })
  await new Promise(r => setImmediate(r))
  assert.equal(S.agents.enabled, false)
  assert.equal(S.chats.has(external.id), false)
  assert.equal(S.chats.has('native'), true)
  assert.equal(S.cur, null)
})

// Small adapter around the existing makeEl stub, scoped to this regression.
// It only models video DOM movement. No browser, media, network or real data.
function installVideoDom(s, targetId = 'msgs') {
  const msgs = s.els.get(targetId)
  let html = '', slots = []
  const attrValue = x => x.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  Object.defineProperty(msgs, 'innerHTML', { configurable: true, get: () => html, set(value) {
    html = value
    slots.forEach(box => box.children.forEach(v => { v.isConnected = false }))
    slots = [...value.matchAll(/<video\b([^>]*)>/g)].map((m, index) => {
      const v = makeEl('video'), attributes = {}
      for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attributes[a[1]] = attrValue(a[2])
      v.attributes = attributes
      for (const [k, value] of Object.entries(attributes)) if (k.startsWith('data-')) v.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
      v.paused = true; v.currentTime = 0; v.isConnected = true; v._fullscreen = false; v._preparing = false; v._previewError = false; v._positionPending = false; v._resumePosition = 0; v.error = null; v._generation = 0; v.playCalls = 0; v.duration = 60
      v.play = () => { v.playCalls++; v.paused = false; return Promise.resolve() }
      v.pause = () => { v.paused = true }
      v.load = () => { v.error = null; v.currentTime = 0 }
      const note = { textContent: '' }, qualityButton = { textContent: '' }, retryButton = { hidden: true, disabled: false }, fullscreenButton = { textContent: '全屏' }
      const box = {
        slot: index, children: [v], classList: makeEl().classList,
        querySelector(selector) { return selector === 'video' ? this.children[0] || null : selector === '.video-note' ? note : selector === '[data-video-quality]' ? qualityButton : selector === '[data-video-retry]' ? retryButton : selector === '[data-video-fullscreen]' ? fullscreenButton : null },
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null },
        replaceChild(old, current) {
          if (old.parentNode) old.parentNode.removeChild(old)
          const at = this.children.indexOf(current)
          assert.notEqual(at, -1, 'placeholder is still in destination')
          this.children[at] = old; current.parentNode = null; old.parentNode = this; old.isConnected = true
        },
      }
      qualityButton.closest = retryButton.closest = fullscreenButton.closest = selector => selector === '[data-video-box]' ? box : null
      v.parentNode = box
      v.closest = selector => selector === '[data-video-box]' ? v.parentNode : null
      return box
    })
  } })
  msgs.querySelectorAll = selector => selector === 'video[data-artifact]' ? slots.flatMap(box => box.children) : []
  msgs.querySelector = selector => selector === 'video' ? slots[0]?.children[0] || null : null
  return { get slots() { return slots }, videos: () => slots.flatMap(box => box.children) }
}

function twoVideoTurns(s, c, onFrame) {
  const text = '[交付视频](<D:/视频项目/delivery/shared.mp4>)'
  for (const it of [
    { k: 'u', seq: 1, text: '第一轮' }, { k: 'a', seq: 2, text: '第一轮过程 ' + text },
    { k: 'a', seq: 3, text }, { k: 'end', seq: 4, reason: 'completed' },
    { k: 'u', seq: 5, text: '第二轮' }, { k: 'a', seq: 6, text: '第二轮过程' },
    { k: 'a', seq: 7, text }, { k: 'end', seq: 8, reason: 'completed' },
  ]) onFrame({ t: 'item', s: c.id, it })
}

for (const firstProgress of [false, true]) for (const secondPaused of [false, true]) {
  test(`history reuse retains the second video's slot (firstProgress=${firstProgress}, secondPaused=${secondPaused})`, async () => {
    const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh, dom = installVideoDom(s)
    twoVideoTurns(s, c, onFrame)
    await rendered()
    assert.equal(dom.videos().length, 2)
    const [first, second] = dom.videos()
    if (firstProgress) { first.currentTime = 4.4; first.dataset.quality = 'preview' }
    second.currentTime = 12.3; second.paused = secondPaused; second.dataset.quality = 'original'
    tapResult(s, '[data-process]', { process: '2' }) // real renderMsgs, no copied implementation
    assert.equal(dom.videos().length, 2, 'each historical result still owns a video')
    assert.equal(dom.slots[1].children[0], second, 'the second result retains its own player node')
    assert.notEqual(dom.slots[0].children[0], second, 'second player never replaces the first result')
    assert.equal(second.currentTime, 12.3)
    assert.equal(second.paused, secondPaused)
    assert.equal(second.dataset.quality, 'original')
    if (firstProgress) assert.equal(dom.slots[0].children[0], first, 'first result retains its progressed node too')
  })
}

test('a paused preview-preparing player at time zero survives a real message render', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh, dom = installVideoDom(s)
  twoVideoTurns(s, c, onFrame); await rendered()
  const second = dom.videos()[1]
  second._preparing = true; second._generation = 9; second.currentTime = 0; second.paused = true
  tapResult(s, '[data-process]', { process: '2' })
  assert.equal(dom.videos().length, 2)
  assert.equal(dom.slots[1].children[0], second)
  assert.equal(second._preparing, true)
  assert.equal(second._generation, 9)
  assert.equal(second.currentTime, 0)
})

function tapVideoInMessage(s, seq) {
  const owner = { dataset: { messageSeq: String(seq) } }
  const button = { dataset: { openVideo: 'D:/视频项目/delivery/shared.mp4' }, closest: selector => selector === '[data-message-seq]' ? owner : null }
  s.els.get('scroller').dispatch('click', { target: { closest: selector => selector === '[data-open-video]' ? button : null }, preventDefault() {} })
}

test('a video link plays its own completed message player rather than the first historical match', async () => {
  const s = bootApp(), c = resultChat(s), { onFrame } = s.window.__dsh, dom = installVideoDom(s)
  twoVideoTurns(s, c, onFrame); await rendered()
  const [first, second] = dom.videos()
  tapVideoInMessage(s, 7)
  assert.equal(first.playCalls, 0)
  assert.equal(second.playCalls, 1)
})

test('a process link with no player of its own uses the existing file viewer', async () => {
  const s = bootApp({ readResult: () => ({ ok: true, value: { kind: 'media', type: 'video/mp4', rel: 'delivery/shared.mp4', name: 'shared.mp4', size: 20, at: 0 } }) })
  const c = resultChat(s), { onFrame } = s.window.__dsh, dom = installVideoDom(s)
  twoVideoTurns(s, c, onFrame); await rendered()
  tapResult(s, '[data-process]', { process: '2' })
  tapVideoInMessage(s, 2); await rendered()
  assert.ok(dom.videos().every(v => v.playCalls === 0))
  assert.equal(s.readCalls.length, 1)
  assert.equal(new URL(s.readCalls[0], 'http://test').searchParams.get('path'), 'D:/视频项目/delivery/shared.mp4')
})

function previewApi(s) {
  const original = s.fetch, calls = [], pending = []
  s.fetch = (url, opts) => {
    if (!String(url).startsWith('/m/api/video?')) return original(url, opts)
    calls.push(String(url))
    return new Promise((resolve, reject) => pending.push({ resolve, reject }))
  }
  return {
    calls,
    reply(value) { assert.ok(pending.length, 'there is a pending preview request'); pending.shift().resolve({ status: 200, json: () => Promise.resolve({ ok: true, value }) }) },
    fail(code) { assert.ok(pending.length, 'there is a pending preview request'); pending.shift().reject(Object.assign(new Error(code), { code })) },
  }
}
function tapVideoControl(s, box, selector, targetId = 'scroller') {
  const button = box.querySelector(selector)
  s.els.get(targetId).dispatch('click', { target: { closest: wanted => wanted === selector ? button : null }, preventDefault() {} })
}
async function previewChat() {
  const s = bootApp(), c = resultChat(s), dom = installVideoDom(s), api = previewApi(s)
  twoVideoTurns(s, c, s.window.__dsh.onFrame); await rendered()
  return { s, c, dom, api, v: dom.videos()[1], box: dom.slots[1] }
}

test('an expired preview retries only on explicit intent and keeps its position across a second load error', async () => {
  const { s, dom, api, v, box } = await previewChat()
  v.dataset.previewReady = '1'; v.currentTime = 8.2
  v.error = { code: 4 }; v.paused = true; v.onerror()
  v.play = () => { v.playCalls++; return v.error ? Promise.reject(new Error('NotSupportedError without onplay')) : Promise.resolve() }
  assert.equal(api.calls.length, 0, 'MediaError itself makes no API request')
  tapVideoControl(s, box, '[data-video-retry]')
  tapVideoControl(s, box, '[data-video-retry]')
  assert.equal(api.calls.length, 1, 'explicit retry works even if native play never emits onplay, and duplicate clicks merge')
  api.reply({ state: 'ready', url: '/synthetic-expired-preview', original: '/synthetic-original' }); await rendered()
  assert.equal(v.currentTime, 0, 'loading a replacement resets native position before metadata')
  v.error = { code: 4 }; v.onerror()
  tapVideoControl(s, box, '[data-video-retry]')
  assert.equal(api.calls.length, 2, 'another retry is an explicit user action')
  api.reply({ state: 'ready', url: '/synthetic-repaired-preview', original: '/synthetic-original' }); await rendered()
  v.dispatch('loadedmetadata')
  assert.equal(v.currentTime, 8.2, 'desired position survives load -> zero -> MediaError before metadata')
  assert.equal(box.querySelector('[data-video-retry]').hidden, true)
  assert.equal(dom.videos()[1], v)
})

test('the file viewer has the same explicit preview retry without relying on native onplay', async () => {
  const s = bootApp({ readResult: () => ({ ok: true, value: { kind: 'media', type: 'video/mp4', rel: 'delivery/shared.mp4', name: 'shared.mp4', size: 20, at: 0 } }) })
  const c = resultChat(s), dom = installVideoDom(s), viewer = installVideoDom(s, 'fvBody'), api = previewApi(s)
  twoVideoTurns(s, c, s.window.__dsh.onFrame); await rendered()
  tapVideoInMessage(s, 2); await rendered()
  const v = viewer.videos()[0], box = viewer.slots[0]
  assert.ok(v, 'the actual file viewer renders a player')
  v.dataset.previewReady = '1'; v.currentTime = 6.4; v.error = { code: 4 }; v.onerror()
  v.play = () => { v.playCalls++; return v.error ? Promise.reject(new Error('NotSupportedError without onplay')) : Promise.resolve() }
  assert.equal(api.calls.length, 0)
  assert.equal(box.querySelector('[data-video-retry]').hidden, false)
  tapVideoControl(s, box, '[data-video-retry]', 'fvBody')
  tapVideoControl(s, box, '[data-video-retry]', 'fvBody')
  assert.equal(api.calls.length, 1)
  api.reply({ state: 'ready', url: '/synthetic-ready-preview', original: '/synthetic-original' }); await rendered()
  v.dispatch('loadedmetadata')
  assert.equal(v.currentTime, 6.4)
  assert.equal(box.querySelector('[data-video-retry]').hidden, true)
  assert.ok(dom.videos().every(movie => movie.playCalls === 0), 'viewer retry does not touch historical chat players')
})

test('a failed paused preview at time zero retains its node and retry UI through message rendering', async () => {
  const { s, dom, api, v } = await previewChat()
  v.dataset.previewReady = '1'; v.currentTime = 0; v.paused = true; v.error = { code: 4 }; v.onerror()
  assert.equal(api.calls.length, 0)
  v.onplay()
  assert.equal(api.calls.length, 0, 'an error does not create an implicit retry loop')
  tapResult(s, '[data-process]', { process: '2' })
  assert.equal(dom.slots[1].children[0], v, 'the failed zero-position node is still owned by its message')
  const box = dom.slots[1]
  assert.equal(box.querySelector('[data-video-retry]').hidden, false)
  assert.match(box.querySelector('.video-note').textContent, /暂不能播放.*重试预览/)
  assert.equal(api.calls.length, 0, 're-rendering does not prepare a video')
  tapVideoInMessage(s, 7)
  assert.equal(api.calls.length, 1, 'its explicit delivery link can also request a retry')
})

test('a late preview API reply cannot change the user-selected original mode', async () => {
  const { s, api, v, box } = await previewChat()
  v.currentTime = 9.1; v.onplay()
  assert.equal(api.calls.length, 1)
  tapVideoControl(s, box, '[data-video-quality]')
  const originalSrc = v.src
  api.reply({ state: 'ready', url: '/obsolete-preview-response', original: '/synthetic-original' }); await rendered()
  assert.equal(v.dataset.quality, 'original')
  assert.equal(v.src, originalSrc)
  assert.equal(box.querySelector('.video-note').textContent, '原画')
  assert.equal(box.querySelector('[data-video-retry]').hidden, true)
})

test('late metadata and play rejection preserve current mode and honest MediaError UI', async () => {
  const { s, api, v, box } = await previewChat()
  const playRejections = []
  v.play = () => new Promise((resolve, reject) => playRejections.push(reject))
  v.currentTime = 8.2; v.onplay()
  api.reply({ state: 'ready', url: '/synthetic-expired-preview', original: '/synthetic-original' }); await rendered()
  const staleMetadata = v.listeners.loadedmetadata[0].fn
  v.error = { code: 4 }; v.onerror()
  playRejections.shift()(new Error('MediaError rejects after error event')); await rendered()
  assert.match(box.querySelector('.video-note').textContent, /暂不能播放.*重试预览/)
  assert.equal(box.querySelector('[data-video-retry]').hidden, false)
  assert.equal(api.calls.length, 1, 'error and late play rejection do not retry')
  tapVideoControl(s, box, '[data-video-quality]')
  const originalMetadata = v.listeners.loadedmetadata.at(-1).fn
  tapVideoControl(s, box, '[data-video-quality]')
  assert.equal(api.calls.length, 2, 'switching back to preview prepares directly')
  v.currentTime = 2.5
  staleMetadata(); originalMetadata()
  playRejections.shift()(new Error('old original play rejects after next mode')); await rendered()
  assert.equal(v.currentTime, 2.5, 'metadata from obsolete sources cannot seek the new mode')
  assert.equal(box.querySelector('.video-note').textContent, '正在准备流畅预览…', 'old play.catch cannot replace the current preparation note')
  api.reply({ state: 'ready', url: '/synthetic-new-preview', original: '/synthetic-original' }); await rendered()
  v.listeners.loadedmetadata.at(-1).fn()
  assert.equal(v.currentTime, 8.2, 'current metadata restores the intended position')
})

test('normal first play and preview mode switch prepare once while unavailable remains an original fallback', async () => {
  const { s, api, v, box } = await previewChat()
  assert.equal(box.querySelector('[data-video-retry]').hidden, true, 'healthy players do not expose retry')
  v.currentTime = 5.7; v.onplay(); v.onplay()
  assert.equal(api.calls.length, 1)
  api.reply({ state: 'ready', url: '/synthetic-first-preview', original: '/synthetic-original' }); await rendered()
  v.dispatch('loadedmetadata')
  assert.equal(v.currentTime, 5.7)
  v.onplay(); assert.equal(api.calls.length, 1, 'a ready preview does not prepare again')
  tapVideoControl(s, box, '[data-video-quality]')
  v.listeners.loadedmetadata.at(-1).fn()
  tapVideoControl(s, box, '[data-video-quality]')
  assert.equal(api.calls.length, 2, 'switching to preview does not require a new native onplay')
  api.reply({ state: 'unavailable', original: '/synthetic-original-only' }); await rendered()
  assert.equal(v.dataset.quality, 'original')
  assert.equal(v.src, '/synthetic-original-only')
  assert.equal(box.querySelector('[data-video-retry]').hidden, true)
  v.onplay(); assert.equal(api.calls.length, 2, 'unavailable does not automatically requeue an encoder')
})

test('preview request failures wait for explicit retry and not-found still falls back to original', async () => {
  const { s, api, v, box } = await previewChat()
  v.onplay(); api.fail('offline'); await rendered()
  assert.equal(box.querySelector('[data-video-retry]').hidden, false)
  assert.match(box.querySelector('.video-note').textContent, /暂不能播放.*重试预览/)
  v.onplay(); assert.equal(api.calls.length, 1)
  tapVideoControl(s, box, '[data-video-retry]')
  assert.equal(api.calls.length, 2)
  api.fail('not-found'); await rendered()
  assert.equal(v.dataset.quality, 'original')
  assert.match(v.src, /^\/m\/api\/raw\?s=results&path=/)
  assert.equal(box.querySelector('[data-video-retry]').hidden, true)
  v.onplay(); assert.equal(api.calls.length, 2)
})

for (const seekPositions of [[6], [6, 0]]) test(`preview preparation keeps the user's latest seek (${seekPositions.join(' -> ')})`, async () => {
  const { api, v } = await previewChat()
  v.currentTime = 3; v.onplay()
  assert.equal(api.calls.length, 1)
  for (const position of seekPositions) v.currentTime = position
  api.reply({ state: 'ready', url: '/synthetic-seek-preview', original: '/synthetic-original' }); await rendered()
  v.dispatch('loadedmetadata')
  assert.equal(v.currentTime, seekPositions.at(-1), 'preparation leaves the source seekable and captures the latest position when loading')
})

function fullscreenHistory(s, c) {
  const states = [{ v: 'chat', s: c.id }]
  s.history.state = states[0]
  s.history.pushState = state => { states.push(state); s.history.state = state }
  s.history.back = () => { if (states.length > 1) states.pop(); s.history.state = states.at(-1); s.dispatchWindow('popstate', { state: s.history.state }) }
  return states
}

test('explicit fullscreen preserves the active player and native exit closes exactly its overlay', async () => {
  const { s, c, dom, v, box } = await previewChat(), history = fullscreenHistory(s, c)
  let requests = 0
  s.document.fullscreenEnabled = true
  box.requestFullscreen = () => { requests++; s.document.fullscreenElement = box; s.dispatchDocument('fullscreenchange', {}); return Promise.resolve() }
  s.document.exitFullscreen = () => { s.document.fullscreenElement = null; s.dispatchDocument('fullscreenchange', {}); return Promise.resolve() }
  v.currentTime = 7.3; v.paused = false; v.dataset.quality = 'original'
  const source = v.src
  tapVideoControl(s, box, '[data-video-fullscreen]')
  await rendered()
  assert.match(s.els.get('msgs').innerHTML, /data-video-fullscreen/)
  assert.equal(requests, 1)
  assert.equal(history.length, 2)
  assert.equal(box.querySelector('[data-video-fullscreen]').textContent, '退出全屏')
  assert.equal(dom.videos()[1], v)
  assert.equal(v.currentTime, 7.3)
  assert.equal(v.paused, false)
  assert.equal(v.dataset.quality, 'original')
  assert.equal(v.src, source)
  assert.equal(v.playCalls, 0, 'enlarging never restarts the player')
  s.document.fullscreenElement = null; s.dispatchDocument('fullscreenchange', {})
  assert.equal(history.length, 1, 'native Escape/exit removes only the fullscreen history entry')
  assert.equal(s.window.__dsh.S.cur, c.id)
  assert.equal(box.querySelector('[data-video-fullscreen]').textContent, '全屏')
  assert.equal(v.currentTime, 7.3)
})

for (const mode of ['unsupported', 'denied', 'installed-webview']) test(`fullscreen fallback keeps a paused zero-position player and receives frames (${mode})`, async () => {
  const { s, c, dom, v, box } = await previewChat(), history = fullscreenHistory(s, c)
  let requests = 0
  if (mode !== 'unsupported') box.requestFullscreen = () => { requests++; return Promise.reject(new Error('fullscreen denied')) }
  if (mode === 'installed-webview') s.navigator.userAgent = 'Android DSHApp/1.3.2+10302'
  v.currentTime = 0; v.paused = true
  tapVideoControl(s, box, '[data-video-fullscreen]'); await rendered()
  assert.equal(requests, mode === 'denied' ? 1 : 0)
  assert.equal(history.length, 2)
  assert.equal(box.classList.contains('video-expanded'), true, 'viewport expansion remains usable without native fullscreen')
  tapResult(s, '[data-process]', { process: '2' })
  s.window.__dsh.onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 9, text: '全屏期间的新结果' } })
  s.window.__dsh.onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 10, reason: 'completed' } }); await rendered()
  assert.equal(dom.videos()[1], v, 'frames must never detach the expanded player')
  assert.ok(c.items.some(it => it.text === '全屏期间的新结果'), 'state still receives the actual frame')
  assert.doesNotMatch(s.els.get('msgs').innerHTML, /全屏期间的新结果/, 'only message DOM rebuilding is deferred')
  s.history.back()
  assert.equal(history.length, 1)
  assert.equal(s.window.__dsh.S.cur, c.id)
  assert.equal(box.classList.contains('video-expanded'), false)
  assert.match(s.els.get('msgs').innerHTML, /全屏期间的新结果/, 'exit paints the received result')
  assert.equal(dom.videos()[1], v, 'exit restores even a paused player at zero to its own message')
  assert.equal(v.currentTime, 0)
  assert.equal(v.paused, true)
  assert.equal(v.playCalls, 0)
})

test('file viewer fullscreen exit and Escape preserve the viewer before its own back level', async () => {
  const s = bootApp({ readResult: () => ({ ok: true, value: { kind: 'media', type: 'video/mp4', rel: 'delivery/shared.mp4', name: 'shared.mp4', size: 20, at: 0 } }) })
  const c = resultChat(s), history = fullscreenHistory(s, c), dom = installVideoDom(s), viewer = installVideoDom(s, 'fvBody')
  twoVideoTurns(s, c, s.window.__dsh.onFrame); await rendered()
  tapVideoInMessage(s, 2); await rendered()
  const v = viewer.videos()[0], box = viewer.slots[0]
  v.currentTime = 4.6; v.paused = true
  assert.equal(history.length, 2)
  tapVideoControl(s, box, '[data-video-fullscreen]', 'fvBody')
  assert.equal(history.length, 3)
  tapVideoControl(s, box, '[data-video-fullscreen]', 'fvBody')
  assert.equal(history.length, 2, 'exit button only closes the fullscreen layer')
  assert.equal(s.els.get('fv').hidden, false)
  assert.equal(viewer.videos()[0], v)
  assert.equal(v.currentTime, 4.6)
  tapVideoControl(s, box, '[data-video-fullscreen]', 'fvBody')
  s.dispatchWindow('keydown', { key: 'Escape' })
  assert.equal(history.length, 2, 'Escape leaves the viewer open too')
  assert.equal(v.currentTime, 4.6)
  assert.equal(v.paused, true)
  s.history.back()
  assert.equal(history.length, 1)
  assert.equal(s.window.__dsh.S.cur, c.id)
  assert.ok(dom.videos().every(movie => movie.playCalls === 0), 'viewer fullscreen never plays a historical message')
})

test('a late fullscreen request cannot reopen an exited overlay', async () => {
  const { s, c, v, box } = await previewChat(), history = fullscreenHistory(s, c)
  let finish, exits = 0
  box.requestFullscreen = () => new Promise(resolve => { finish = resolve })
  s.document.exitFullscreen = () => { exits++; s.document.fullscreenElement = null; return Promise.resolve() }
  v.currentTime = 3.2; v.paused = true
  tapVideoControl(s, box, '[data-video-fullscreen]')
  tapVideoControl(s, box, '[data-video-fullscreen]')
  assert.equal(history.length, 1)
  s.document.fullscreenElement = box; finish(); await rendered()
  assert.equal(exits, 1, 'obsolete successful API request is exited rather than reviving the overlay')
  assert.equal(history.length, 1)
  assert.equal(box.classList.contains('video-expanded'), false)
  assert.equal(box.querySelector('[data-video-fullscreen]').textContent, '全屏')
  assert.equal(v.currentTime, 3.2)
  assert.equal(v.playCalls, 0)
})

test('fullscreen repeated exit intents wait for one asynchronous popstate', async () => {
  const { s, c, box } = await previewChat(), history = fullscreenHistory(s, c)
  let backRequests = 0
  s.history.back = () => { backRequests++ } // browser popstate arrives later
  tapVideoControl(s, box, '[data-video-fullscreen]')
  tapVideoControl(s, box, '[data-video-fullscreen]')
  s.dispatchWindow('keydown', { key: 'Escape' })
  tapVideoControl(s, box, '[data-video-fullscreen]')
  assert.equal(backRequests, 1, 'repeated button/Escape exits cannot retreat to the parent layer')
  history.pop(); s.history.state = history.at(-1); s.dispatchWindow('popstate', { state: s.history.state })
  assert.equal(box.classList.contains('video-expanded'), false)
  assert.equal(s.window.__dsh.S.cur, c.id)
  tapVideoControl(s, box, '[data-video-fullscreen]')
  tapVideoControl(s, box, '[data-video-fullscreen]')
  assert.equal(backRequests, 2, 'a later fullscreen entry gets its own close intent')
})

// Regression cases for the real app.js's native fullscreenchange seam.
// These are DOM/event contract tests. They do not verify Android's icon or host.

for (const pausedAtZero of [false, true]) test(`native controls fullscreen keeps the same connected message player (pausedAtZero=${pausedAtZero})`, async () => {
  const { s, c, dom, v, box } = await previewChat(), history = fullscreenHistory(s, c)
  s.navigator.userAgent = 'Android DSHApp/1.3.2+10302'
  v.currentTime = pausedAtZero ? 0 : 12.3
  v.paused = pausedAtZero
  v.dataset.quality = 'original'
  const source = v.src
  let connected = true, detaches = 0
  Object.defineProperty(v, 'isConnected', { configurable: true, get: () => connected, set(value) { connected = value; if (!value) detaches++ } })

  // Native video controls make the video the fullscreen element, rather than
  // clicking our separate [data-video-fullscreen] button or expanding its box.
  s.document.fullscreenElement = v
  s.dispatchDocument('fullscreenchange', { target: v })
  assert.equal(history.length, 1, 'native fullscreen does not create a second frontend back level')
  s.window.__dsh.onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 9, text: 'native fullscreen received frame' } })
  s.window.__dsh.onFrame({ t: 'item', s: c.id, it: { k: 'end', seq: 10, reason: 'completed' } })
  await rendered()

  assert.ok(c.items.some(it => it.text === 'native fullscreen received frame'), 'stream state keeps receiving actual frames')
  assert.equal(detaches, 0, 'message repaint must not detach a native fullscreen video even temporarily')
  assert.equal(dom.slots[1], box, 'the fullscreen player box is kept in its existing message')
  assert.equal(dom.videos()[1], v)
  assert.equal(v.currentTime, pausedAtZero ? 0 : 12.3)
  assert.equal(v.paused, pausedAtZero)
  assert.equal(v.src, source)
  assert.equal(v.playCalls, 0)
  assert.doesNotMatch(s.els.get('msgs').innerHTML, /native fullscreen received frame/, 'paint waits for fullscreen exit')

  // Android's native Back is expected to dismiss the host and cause this event.
  // Exercising that native callback and actual hardware Back is a separate test.
  s.document.fullscreenElement = null
  s.dispatchDocument('fullscreenchange', { target: v })
  await rendered()
  assert.match(s.els.get('msgs').innerHTML, /native fullscreen received frame/)
  assert.equal(dom.videos()[1], v, 'exit retains even a paused player at zero')
  assert.equal(v.currentTime, pausedAtZero ? 0 : 12.3)
  assert.equal(v.paused, pausedAtZero)
  assert.equal(v.playCalls, 0)
  assert.equal(history.length, 1, 'native exit leaves the current chat and its back level intact')
  assert.equal(s.window.__dsh.S.cur, c.id)
})

test('installed custom fullscreen switching session never reuses another session video', async () => {
  const { s, c, dom, v, box } = await previewChat(), states = fullscreenHistory(s, c)
  s.history.go = delta => {
    assert.ok(delta < 0)
    states.splice(Math.max(1, states.length + delta))
    s.history.state = states.at(-1)
    s.dispatchWindow('popstate', { state: s.history.state })
  }
  s.navigator.userAgent = 'Android DSHApp/1.3.2+10302'
  v.currentTime = 12.3; v.paused = false
  tapVideoControl(s, box, '[data-video-fullscreen]')
  const other = resultChat(s, 'other-results')
  // resultChat populates a new state and selects it; restore the actual old
  // selection so that dshOpen, rather than the fixture setup, performs the switch.
  s.window.__dsh.S.cur = c.id
  twoVideoTurns(s, other, s.window.__dsh.onFrame)
  s.window.dshOpen(other.id)
  await rendered()
  assert.equal(s.window.__dsh.S.cur, other.id)
  assert.equal(box.classList.contains('video-expanded'), false)
  assert.equal(v._fullscreen, false)
  assert.equal(s.history.state.od, undefined, 'fullscreen overlay is closed before the new chat is pushed')
  assert.equal(dom.videos().length, 2)
  assert.ok(dom.videos().every(movie => movie !== v && movie.dataset.session === other.id), 'same paths and message sequences cannot import the old session player')
  assert.ok(dom.videos().every(movie => movie.currentTime === 0 && movie.playCalls === 0))
})

test('native fullscreen exit after session switch cannot repaint or import the previous video', async () => {
  const { s, c, dom, v } = await previewChat()
  s.navigator.userAgent = 'Android DSHApp/1.3.2+10302'
  const other = resultChat(s, 'other-results')
  s.window.__dsh.S.cur = c.id
  twoVideoTurns(s, other, s.window.__dsh.onFrame)
  v.currentTime = 12.3; v.paused = false
  s.document.fullscreenElement = v
  s.dispatchDocument('fullscreenchange', { target: v })
  s.window.__dsh.onFrame({ t: 'item', s: c.id, it: { k: 'a', seq: 9, text: 'old fullscreen pending result' } })
  await rendered()
  s.window.dshOpen(other.id)
  await rendered()
  // The native host's exit event may arrive after the session navigation.
  s.document.fullscreenElement = null
  s.dispatchDocument('fullscreenchange', { target: v })
  await rendered()
  assert.equal(s.window.__dsh.S.cur, other.id)
  assert.equal(v._fullscreen, false, 'the old native fullscreen state is released')
  assert.ok(dom.videos().every(movie => movie !== v && movie.dataset.session === other.id))
  assert.ok(dom.videos().every(movie => movie.currentTime === 0 && movie.playCalls === 0))
  assert.doesNotMatch(s.els.get('msgs').innerHTML, /old fullscreen pending result/, 'late exit does not paint the previous chat into the new one')
})
