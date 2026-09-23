'use strict'
/*
 * DSH phone client. Plain DOM, no framework, no build step.
 *
 * Data flow
 *   GET  /m/api/boot     -> workspaces + session list
 *   GET  /m/api/history  -> folded messages for one session (see fold.js)
 *   SSE  /m/api/events   -> live frames for every session (deltas, tool rows,
 *                           run status, approvals, questions, queue, todos)
 *   POST /m/api/rpc      -> prompt / cancel / create / models / rename ...
 *   POST /m/api/respond  -> approval & question answers
 *
 * Every live frame carries the session event seq; a chat drops frames its
 * history page already contained (seq <= lastSeq), so "load history, then keep
 * streaming" never duplicates or loses text.
 */
;(function () {
  // ------------------------------------------------------------ utilities
  var $ = function (s) { return document.querySelector(s) }
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c] }) }
  function enc(s) { return encodeURIComponent(s) }
  function pad(n) { return (n < 10 ? '0' : '') + n }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID()
    var b = crypto.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1) }).join('')
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20)
  }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 10) } catch (e) {} }
  var TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch (e) { return undefined } })()
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('dsh.' + k); return v == null ? d : JSON.parse(v) } catch (e) { return d } },
    set: function (k, v) { try { localStorage.setItem('dsh.' + k, JSON.stringify(v)) } catch (e) {} },
  }

  function when(t) {
    var now = new Date(), d = new Date(t), diff = now - d
    if (diff < 60e3) return '刚刚'
    if (diff < 3600e3) return Math.floor(diff / 60e3) + '分钟前'
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
    var day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    if (t >= day0) return hm
    if (t >= day0 - 864e5) return '昨天 ' + hm
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日'
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate()
  }
  function bucket(t) {
    var now = new Date(), day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    if (t >= day0) return 1
    if (t >= day0 - 864e5) return 2
    if (t >= day0 - 6 * 864e5) return 3
    return 4
  }
  function dur(ms) {
    var s = Math.round(ms / 1000)
    if (s < 60) return s + '秒'
    var m = Math.floor(s / 60)
    if (m < 60) return m + '分' + (s % 60 ? (s % 60) + '秒' : '')
    return Math.floor(m / 60) + '小时' + (m % 60 ? (m % 60) + '分' : '')
  }

  // ------------------------------------------------------------ icons
  var P = {
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    more: '<g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></g>',
    send: '<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5.2-5.2a1.5 1.5 0 0 0-2.1 0L5 19.5"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    down: '<path d="M12 5v14M5.5 12.5L12 19l6.5-6.5"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    execute: '<path d="M4 17l6-5-6-5M12 19h8"/>',
    read: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    edit: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3zM14.5 7.5l3 3"/>',
    web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    agent: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13v1.5M15 13v1.5"/>',
    other: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8V20h3.2l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
    delete: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    alert: '<path d="M12 3l9.5 17h-19zM12 10v4M12 17.5v.5"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    pen: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
    circle: '<circle cx="12" cy="12" r="8"/>',
    dotc: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
    checkc: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
    xc: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
    bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
    zap: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
    stats: '<path d="M5 20V11M12 20V5M19 20v-8"/>',
  }
  function ic(n, cls) { return '<svg class="i' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (P[n] || P.other) + '</svg>' }
  var KI = { execute: 'execute', read: 'read', edit: 'edit', search: 'search', web: 'web', fetch: 'web', agent: 'agent', delete: 'delete', move: 'edit', think: 'bulb', other: 'other' }
  function toolLabel(name) {
    if (!name) return '工具'
    if (/^mcp__chrome__/.test(name)) return '浏览器'
    return ({ pwsh: '终端', bash: '终端', read: '读取文件', read_image: '看图片', write: '写文件', edit: '编辑文件', grep: '搜索', glob: '找文件', web_search: '联网搜索', web_fetch: '打开网页', subagent: '子代理', todo_write: '更新进度' })[name] || name
  }

  // ------------------------------------------------------------ markdown
  // Escape first, then add a closed set of constructs; raw HTML never passes.
  var LI = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/
  function inline(s) {
    var codes = []
    s = String(s).replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return '' + (codes.length - 1) + '' })
    s = esc(s)
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, t, u) { return '<a href="' + u + '">' + t + '</a>' })
    s = s.replace(/(^|[\s(（：:，,])(https?:\/\/[^\s<>()（）]+[^\s<>()（）.,;:!?。，；：！？'"])/g, function (_, p, u) { return p + '<a href="' + u + '">' + u + '</a>' })
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<b>$1</b>')
    s = s.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, '$1<i>$2</i>')
    s = s.replace(/~~(?=\S)([^~]*?\S)~~/g, '<s>$1</s>')
    return s.replace(/(\d+)/g, function (_, n) { return '<code>' + esc(codes[n]) + '</code>' })
  }
  function table(rows) {
    function cells(r) { return r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim() }) }
    var head = cells(rows[0])
    var body = rows.slice(2).map(cells)
    return '<div class="tbl"><table><thead><tr>' + head.map(function (c) { return '<th>' + inline(c) + '</th>' }).join('') + '</tr></thead><tbody>' +
      body.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>' }).join('') + '</tr>' }).join('') + '</tbody></table></div>'
  }
  function list(lines) {
    var html = '', stack = []
    lines.forEach(function (line) {
      var m = LI.exec(line)
      if (!m) { html += '<br>' + inline(line.trim()); return }
      var ind = m[1].replace(/\t/g, '    ').length, tag = /\d/.test(m[2]) ? 'ol' : 'ul', text = m[3]
      while (stack.length && ind < stack[stack.length - 1].ind) html += '</li></' + stack.pop().tag + '>'
      var top = stack[stack.length - 1]
      if (!top || ind > top.ind) { html += '<' + tag + '><li>'; stack.push({ ind: ind, tag: tag }) } else html += '</li><li>'
      var ck = /^\[( |x|X)\]\s+/.exec(text)
      if (ck) { html += '<span class="ck">' + (ck[1] === ' ' ? '☐' : '☑') + '</span> '; text = text.slice(ck[0].length) }
      html += inline(text)
    })
    while (stack.length) html += '</li></' + stack.pop().tag + '>'
    return html
  }
  function md(src) {
    var L = String(src || '').replace(/\r\n?/g, '\n').split('\n'), out = '', para = [], i = 0, m
    function flush() { if (para.length) { out += '<p>' + para.map(inline).join('<br>') + '</p>'; para = [] } }
    while (i < L.length) {
      var l = L[i]
      if ((m = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(l))) {
        flush()
        var fence = m[1], lang = m[2], buf = []
        i++
        while (i < L.length && L[i].trim().indexOf(fence) !== 0) buf.push(L[i++])
        i++
        out += '<pre class="code"><div class="code-h"><span>' + esc(lang || 'code') + '</span><button data-copy>复制</button></div><code>' + esc(buf.join('\n')) + '</code></pre>'
        continue
      }
      if (!l.trim()) { flush(); i++; continue }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < L.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(L[i + 1])) {
        flush()
        var rows = []
        while (i < L.length && /^\s*\|.*\|\s*$/.test(L[i])) rows.push(L[i++])
        out += table(rows)
        continue
      }
      if ((m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l))) { flush(); var n = Math.min(5, m[1].length + 2); out += '<h' + n + '>' + inline(m[2]) + '</h' + n + '>'; i++; continue }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out += '<hr>'; i++; continue }
      if (/^\s*>/.test(l)) {
        flush()
        var q = []
        while (i < L.length && /^\s*>/.test(L[i])) q.push(L[i++].replace(/^\s*>\s?/, ''))
        out += '<blockquote>' + md(q.join('\n')) + '</blockquote>'
        continue
      }
      if (LI.test(l)) {
        flush()
        var items = []
        while (i < L.length && (LI.test(L[i]) || (items.length && /^\s{2,}\S/.test(L[i])))) items.push(L[i++])
        out += list(items)
        continue
      }
      para.push(l)
      i++
    }
    flush()
    return out
  }
  function withCursor(html) {
    var k = Math.max(html.lastIndexOf('</p>'), html.lastIndexOf('</li>'))
    return k >= 0 && k > html.length - 16 ? html.slice(0, k) + '<i class="cursor"></i>' + html.slice(k) : html + '<i class="cursor"></i>'
  }

  // ------------------------------------------------------------ api
  // Reload and let the gateway run its own login flow (any gateway, any login
  // URL). A second bounce within 15 s means the gateway keeps refusing: stop.
  function toLogin() {
    var last = 0
    try { last = +sessionStorage.getItem('dsh.relogin') || 0 } catch (e) {}
    if (Date.now() - last < 15000) { setStatus('offline'); toast('需要重新登录网关', 'err'); return }
    try { sessionStorage.setItem('dsh.relogin', String(Date.now())) } catch (e) {}
    location.reload()
  }
  function handle(r) {
    if (r.type === 'opaqueredirect' || r.status === 401) { toLogin(); return Promise.reject(new Error('需要重新登录')) }
    if (r.status === 502 || r.status === 503 || r.status === 504) { setStatus('offline'); return Promise.reject(new Error('家里电脑暂时连不上')) }
    return r.json().then(function (j) {
      if (!j || !j.ok) throw Object.assign(new Error((j && j.error && j.error.message) || '请求失败'), { code: j && j.error && j.error.code })
      return j.value
    }, function () { throw new Error('请求失败 (HTTP ' + r.status + ')') })
  }
  function get(path) { return fetch(path, { cache: 'no-store', redirect: 'manual' }).then(handle) }
  function post(path, body) { return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' }).then(handle) }
  function rpc(method, payload, rpcId) { return post('/m/api/rpc', { method: method, payload: payload, rpcId: rpcId }) }
  function respond(rpcId, result) { return post('/m/api/respond', { rpcId: rpcId, result: result }) }
  function imgUrl(s, id) { return '/m/api/img?s=' + enc(s) + '&id=' + enc(id) }

  // ------------------------------------------------------------ state
  var S = {
    ws: [], wsById: {}, sessions: [], byId: {}, blanks: {},
    run: new Set(), asks: new Map(), qs: new Map(), chats: new Map(),
    filter: store.get('filter', 'all'), query: '', cur: null, booted: false, hellos: 0,
    att: [], drafts: store.get('drafts', {}), status: 'connecting',
    agents: { mode: 'auto', away: false, sessions: [] },
  }
  var el = {}
  ;['app', 'home', 'chat', 'status', 'chips', 'list', 'rows', 'ptr', 'fab', 'searchBox', 'q', 'cTitle', 'cSub', 'scroller', 'older', 'msgs', 'tail',
    'toBottom', 'dock', 'input', 'send', 'attach', 'quick', 'file', 'thumbs', 'sheetWrap', 'sheet', 'viewer', 'toast', 'head',
    'fv', 'fvBody', 'fvTitle', 'fvSub', 'fvAct'].forEach(function (id) { el[id] = document.getElementById(id) })

  function chatState(id) {
    return { id: id, items: [], pending: [], partial: null, lastSeq: -1, firstSeq: -1, hasMore: false, loaded: false, loading: false, err: false,
      buf: [], open: new Set(), todos: null, todoOpen: false, queue: [], title: '', w: null, model: null, models: null }
  }
  // Auto titles occasionally arrive as Markdown ("**Session Title:** x").
  function cleanTitle(t) { return String(t || '').replace(/\*\*|__|`/g, '').replace(/^\s*(session\s*)?title\s*[:：]\s*/i, '').trim() }
  function wsOf(id) { var s = S.byId[id], c = S.chats.get(id); return (s && s.w) || (c && c.w) || null }
  function wsTitle(w) { return w ? (S.wsById[w] ? S.wsById[w].title : '') : '未归类' }
  // Claude Code / Codex sessions on the same PC: ids "agent:<src>:<session>".
  function isAgent(id) { return typeof id === 'string' && id.indexOf('agent:') === 0 }
  function agentOf(id) { var a = S.agents.sessions; for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i]; return null }
  function isRunning(id) { var a = isAgent(id) && agentOf(id); return S.run.has(id) || Boolean(a && a.run) }
  function pendingCount(id) {
    var n = 0
    S.asks.forEach(function (a) { if (a.s === id) n++ })
    S.qs.forEach(function (q) { if (q.s === id) n++ })
    return n
  }

  // ------------------------------------------------------------ status / toast
  function setStatus(st) {
    S.status = st
    el.status.className = 'status ' + st
    el.status.lastChild.textContent = { online: '已连接', connecting: '连接中', offline: '电脑离线' }[st]
    if (S.cur) renderHead()
  }
  var toastT = 0
  function toast(msg, kind) {
    el.toast.textContent = msg
    el.toast.className = 'toast on' + (kind ? ' ' + kind : '')
    clearTimeout(toastT)
    // Errors can carry a next step to read: keep them up longer, by length.
    toastT = setTimeout(function () { el.toast.className = 'toast' }, kind === 'err' ? Math.min(9000, 2600 + String(msg).length * 45) : 2600)
  }
  function copy(text) {
    function fallback() {
      var t = document.createElement('textarea')
      t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'
      document.body.appendChild(t); t.select()
      try { document.execCommand('copy'); toast('已复制') } catch (e) { toast('复制失败', 'err') }
      t.remove()
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('已复制') }, fallback)
    else fallback()
  }

  // ------------------------------------------------------------ home
  function sortedWorkspaces() {
    var last = {}
    S.sessions.forEach(function (s) { if (s.w) last[s.w] = Math.max(last[s.w] || 0, s.at) })
    return S.ws.slice().sort(function (a, b) { return (last[b.id] || 0) - (last[a.id] || 0) })
  }
  function renderChips() {
    var h = '<button class="chip' + (S.filter === 'all' ? ' on' : '') + '" data-f="all">全部</button>'
    sortedWorkspaces().forEach(function (w) { h += '<button class="chip' + (S.filter === w.id ? ' on' : '') + '" data-f="' + esc(w.id) + '">' + esc(w.title) + '</button>' })
    if (S.sessions.some(function (s) { return !s.w })) h += '<button class="chip' + (S.filter === 'none' ? ' on' : '') + '" data-f="none">未归类</button>'
    el.chips.innerHTML = h
  }
  function rowHtml(s) {
    var tag = pendingCount(s.id) ? '<span class="tag ask">待确认</span>' : isRunning(s.id) ? '<span class="tag run"><i></i>运行中</span>' : ''
    return '<button class="row" data-open="' + esc(s.id) + '"><div class="mid"><div class="t' + (s.title ? '' : ' none') + '">' + esc(s.title || '未命名对话') +
      '</div><div class="m">' + tag + '<span>' + esc(wsTitle(s.w)) + '</span></div></div><span class="when">' + when(s.at) + '</span></button>'
  }
  var MODE_SHORT = { auto: '自动', phone: '手机', pc: '电脑' }
  var MODE_NAME = { auto: '自动', phone: '总是先问手机', pc: '只在电脑上确认' }
  var MODE_TXT = {
    auto: '电脑锁屏或 3 分钟没人操作时发到手机，一回到电脑就交还电脑',
    phone: '先发到手机；20 分钟没回应再交给电脑',
    pc: '不发到手机，只在电脑上弹确认框',
  }
  function agentRowHtml(a) {
    var tag = pendingCount(a.id) ? '<span class="tag ask">待确认</span>' : a.run ? '<span class="tag run"><i></i>运行中</span>' : ''
    return '<button class="row" data-open="' + esc(a.id) + '"><span class="fic">' + ic('execute', 's') + '</span><div class="mid"><div class="t' + (a.title ? '' : ' none') + '">' + esc(a.title || a.project || a.name) +
      '</div><div class="m">' + tag + '<span>' + esc(a.name + (a.project ? ' · ' + a.project : '')) + '</span></div></div><span class="when">' + when(a.at) + '</span></button>'
  }
  function agentsHtml() {
    if (S.filter !== 'all' || S.query || !S.agents.sessions.length) return ''
    return '<div class="sec sec-row">Claude Code / Codex<button class="secbtn" data-mode>确认发到：' + esc(MODE_SHORT[S.agents.mode] || S.agents.mode) + ic('chev', 's') + '</button></div>' +
      '<div class="grp agents">' + S.agents.sessions.slice(0, 6).map(agentRowHtml).join('') + '</div>'
  }
  function loadAgents() {
    return get('/m/api/agents').then(function (v) {
      S.agents = v
      scheduleHome()
      if (S.cur && isAgent(S.cur)) { renderHead(); syncSend() }
    }, function () {})
  }
  var agentsT = 0
  function scheduleAgents() {
    clearTimeout(agentsT)
    agentsT = setTimeout(function () {
      loadAgents()
      var c = S.cur && isAgent(S.cur) && S.chats.get(S.cur)
      if (c && c.loaded && !c.loading) loadHistory(c)
    }, 250)
  }
  function modeSheet() {
    var cur = S.agents.mode
    openSheet('<div class="sh-h">Claude Code / Codex 的确认请求<small>它们要你允许某个操作时，发到哪里</small></div><div class="sh-b">' + ['auto', 'phone', 'pc'].map(function (m) {
      return '<button class="opt-row' + (m === cur ? ' on' : '') + '" data-m="' + m + '"><span class="ico">' + ic(m === 'pc' ? 'cpu' : 'alert', 's') + '</span><span class="mid"><b>' + MODE_NAME[m] + '</b><small>' + MODE_TXT[m] + '</small></span>' + (m === cur ? ic('check', 'chk') : '') + '</button>'
    }).join('') + '</div>')
    el.sheet.onclick = function (e) {
      var b = e.target.closest('[data-m]')
      if (!b) return
      post('/m/api/agents/mode', { mode: b.dataset.m }).then(function (v) { S.agents.mode = v.mode; buzz(); closeOverlay(); scheduleHome() }, function (err) { toast(err.message, 'err') })
    }
  }
  function renderHome() {
    renderChips()
    if (!S.booted) { el.rows.innerHTML = new Array(7).join('<div class="sk"></div>'); return }
    var list = S.sessions.filter(function (s) {
      // "全部" mirrors the desktop sidebar: only sessions that belong to a
      // workspace. Leftover ungrouped logs live under the "未归类" chip.
      if (S.filter === 'none' ? s.w : S.filter === 'all' ? !s.w : s.w !== S.filter) return false
      if (!S.query) return true
      var q = S.query.toLowerCase()
      return (s.title || '').toLowerCase().indexOf(q) >= 0 || wsTitle(s.w).toLowerCase().indexOf(q) >= 0
    }).sort(function (a, b) { return b.at - a.at })
    var h = ''
    if (S.appUpdate) {
      h += S.appUpdate.self
        ? '<button class="alert upd" data-update>' + ic('down') + '<span>App 有新版本 ' + esc(S.appUpdate.versionName) + '，点这里更新</span>' + ic('chev', 's') + '</button>'
        : '<div class="alert upd">' + ic('down') + '<span>App 可以升级到 ' + esc(S.appUpdate.versionName) + '：这一次需要在电脑上安装，之后就能在手机上直接更新</span></div>'
    }
    var waiting = S.asks.size + S.qs.size
    if (waiting) {
      var first = (S.asks.values().next().value || S.qs.values().next().value).s
      h += '<button class="alert" data-open="' + esc(first) + '">' + ic('alert') + '<span>' + waiting + ' 个操作等你确认</span>' + ic('chev', 's') + '</button>'
    }
    h += agentsHtml()
    var groups = [['进行中', []], ['今天', []], ['昨天', []], ['最近 7 天', []], ['更早', []]]
    list.forEach(function (s) { groups[isRunning(s.id) || pendingCount(s.id) ? 0 : bucket(s.at)][1].push(s) })
    groups.forEach(function (g) { if (g[1].length) h += '<div class="sec">' + g[0] + '</div><div class="grp">' + g[1].map(rowHtml).join('') + '</div>' })
    if (!list.length) h += '<div class="empty"><b>' + (S.query ? '没有匹配的对话' : '这里还没有对话') + '</b>' + (S.query ? '' : '点右下角 + 开始') + '</div>'
    el.rows.innerHTML = h
  }
  var homeRaf = 0
  function scheduleHome() {
    if (homeRaf) return
    homeRaf = requestAnimationFrame(function () { homeRaf = 0; renderHome() })
  }
  // The last list is kept on the phone so a cold launch paints instantly;
  // the network copy replaces it a moment later.
  function loadBoot() {
    return get('/m/api/boot').then(function (v) {
      store.set('boot', v)
      applyBoot(v)
    })
  }
  function applyBoot(v) {
    S.ws = v.workspaces
    S.wsById = {}
    v.workspaces.forEach(function (w) { S.wsById[w.id] = w })
    S.blanks = v.blanks || {}
    var local = S.byId
    S.sessions = v.sessions
    S.byId = {}
    S.run = new Set()
    v.sessions.forEach(function (s) {
      s.title = cleanTitle(s.title)
      S.byId[s.id] = s
      if (s.run) S.run.add(s.id)
      if (!s.title && local[s.id] && local[s.id].title) s.title = local[s.id].title
    })
    if (S.filter !== 'all' && S.filter !== 'none' && !S.wsById[S.filter]) S.filter = 'all'
    S.booted = true
    renderHome()
    if (S.cur) { renderHead(); syncSend() }
  }
  var bootT = 0
  function scheduleBoot() { clearTimeout(bootT); bootT = setTimeout(function () { loadBoot().catch(function () {}) }, 500) }

  function setRun(id, on) {
    if (on) S.run.add(id); else S.run.delete(id)
    var s = S.byId[id]
    if (s) { s.run = on; s.at = Date.now() }
    else scheduleBoot() // a new (formerly blank) session just started: it now belongs in the list
    scheduleHome()
    if (id === S.cur) {
      var c = S.chats.get(id)
      if (c && !on) c.partial = null
      renderHead(); syncSend(); drawDock()
      if (c) draw(c)
    }
  }
  function setTitle(id, t) {
    t = cleanTitle(t)
    if (!t) return
    var s = S.byId[id], c = S.chats.get(id)
    if (s) s.title = t
    if (c) c.title = t
    scheduleHome()
    if (id === S.cur) renderHead()
  }
  function touch(id) { var s = S.byId[id]; if (s) { s.at = Date.now(); scheduleHome() } }

  // ------------------------------------------------------------ navigation
  function show(view) { el.app.classList.toggle('in-chat', view === 'chat') }
  function openChat(id, fromPop) {
    if (!id) return
    if (S.cur && S.cur !== id) saveDraft()
    S.cur = id
    var c = S.chats.get(id)
    if (!c) { c = chatState(id); S.chats.set(id, c) }
    if (!fromPop) history.pushState({ v: 'chat', s: id }, '', '#' + enc(id))
    show('chat')
    var ag = isAgent(id)
    el.input.value = S.drafts[id] || ''
    el.input.placeholder = ag ? '继续这个会话（电脑在后台运行）' : '发消息给 DSH'
    el.attach.hidden = ag
    autosize()
    S.att = []
    drawThumbs()
    renderHead()
    renderMsgs(c, true)
    drawDock()
    syncSend()
    if (!c.loaded && !c.loading) loadHistory(c)
    if (!ag) loadModel(c)
  }
  function closeChat() {
    saveDraft()
    if (S.cur && !S.byId[S.cur]) scheduleBoot()
    S.cur = null
    show('home')
    el.dock.innerHTML = ''
    renderHome()
  }
  function saveDraft() {
    if (!S.cur) return
    var v = el.input.value
    if (v) S.drafts[S.cur] = v; else delete S.drafts[S.cur]
    store.set('drafts', S.drafts)
  }

  // Overlays (sheet, image viewer, file viewer levels) form a stack; each owns
  // one history entry, tagged with its depth, so Android back closes exactly
  // one level and history.go(-n) closes several.
  var overlays = [], closing = null
  function pushOverlay(kind, onClose) {
    overlays.push({ kind: kind, onClose: onClose })
    history.pushState(Object.assign({}, history.state, { o: kind, od: overlays.length }), '')
  }
  function hasOverlay(kind) { return overlays.some(function (o) { return o.kind === kind }) }
  function closeOverlay() {
    if (!overlays.length) return Promise.resolve()
    return new Promise(function (res) { closing = res; history.back() })
  }
  function closeAllOverlays() {
    if (!overlays.length) return Promise.resolve()
    return new Promise(function (res) { closing = res; history.go(-overlays.length) })
  }
  window.addEventListener('popstate', function (e) {
    var st = e.state || {}
    if (overlays.length > (st.od || 0)) {
      while (overlays.length > (st.od || 0)) overlays.pop().onClose()
      if (closing) { var done = closing; closing = null; done() }
      return
    }
    if (st.v === 'chat' && st.s) openChat(st.s, true)
    else if (S.cur) closeChat()
  })

  function openSheet(html) {
    el.sheet.onclick = null
    el.sheet.innerHTML = html
    el.sheetWrap.hidden = false
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.sheetWrap.classList.add('on') }) })
    pushOverlay('sheet', function () {
      el.sheetWrap.classList.remove('on')
      setTimeout(function () { if (!hasOverlay('sheet')) { el.sheetWrap.hidden = true; el.sheet.innerHTML = '' } }, 340)
    })
  }
  function view(src) {
    el.viewer.firstElementChild.src = src
    el.viewer.hidden = false
    pushOverlay('viewer', function () { el.viewer.hidden = true; el.viewer.firstElementChild.removeAttribute('src') })
  }

  // ------------------------------------------------------------ result viewer
  // One full-screen page per level: a tool call's full detail, a folder, a
  // file. Each level is an overlay, so back walks up the way the user came.
  var fv = []
  function fsize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB' }
  function baseName(p) { var s = String(p || '').replace(/[\\/]+$/, ''); return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1) || s }
  function dirName(rel) { var i = String(rel || '').lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i) }
  function rawUrl(s, rel) { return '/m/api/raw?s=' + enc(s) + '&path=' + enc(rel) }
  function fvOpen(en) {
    fv.push(en)
    el.fv.hidden = false
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.fv.classList.add('on') }) })
    pushOverlay('fv', function () {
      fv.pop()
      if (fv.length) { fvShow(); return }
      el.fv.classList.remove('on')
      setTimeout(function () { if (!fv.length) { el.fv.hidden = true; el.fvBody.innerHTML = '' } }, 320)
    })
    fvShow()
  }
  function fvShow() {
    var en = fv[fv.length - 1]
    el.fvTitle.textContent = en.title || ''
    el.fvSub.textContent = en.sub || ''
    el.fvAct.hidden = true
    el.fvBody.scrollTop = 0
    if (en.data) { fvPaint(en); return }
    el.fvBody.innerHTML = '<div class="spin"></div>'
    var url = en.kind === 'call'
      ? '/m/api/call?s=' + enc(en.s) + '&id=' + enc(en.id) + '&seq=' + en.seq + (en.rseq ? '&rseq=' + en.rseq : '')
      : '/m/api/fs?s=' + enc(en.s) + '&path=' + enc(en.path || '')
    get(url).then(function (v) {
      en.data = v
      if (fv[fv.length - 1] === en) fvPaint(en)
    }, function (e) {
      if (fv[fv.length - 1] === en) el.fvBody.innerHTML = '<div class="empty"><b>打不开</b>' + esc(e.message) + '</div>'
    })
  }
  // Chips only for files the viewer can open: relative paths, or absolute
  // ones under the session's workspace (the server enforces the same rule).
  function wsRoot(sid) { var w = wsOf(sid); return w && S.wsById[w] ? S.wsById[w].path : '' }
  function normP(p) { return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() }
  function inRoot(p, root) {
    if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(p)) return true
    var a = normP(p), r = normP(root)
    return Boolean(r) && (a === r || a.indexOf(r + '/') === 0)
  }
  function chipsHtml(paths, root) {
    return (paths || []).filter(function (p) { return inRoot(p, root) }).map(function (p) {
      return '<button data-fp="' + esc(p) + '">' + ic('read', 's') + '<span>' + esc(baseName(p)) + '</span></button>'
    }).join('')
  }
  function fvPaint(en) {
    var d = en.data, h = ''
    if (en.kind === 'call') {
      el.fvSub.textContent = toolLabel(d.name) + (d.done ? (d.err ? ' · 失败' : ' · 完成') : ' · 进行中')
      var chips = chipsHtml(d.paths, wsRoot(en.s))
      if (chips) h += '<div class="tacts fvchips">' + chips + '</div>'
      if (d.diffs && d.diffs.length) d.diffs.forEach(function (x) { h += diffHtml(x) })
      else if (d.input) h += '<div class="fvsec">内容</div><pre class="fvtext">' + esc(d.input) + '</pre>'
      if (d.out) h += '<div class="fvsec">' + (d.err ? '出错信息' : '结果') + '</div><pre class="fvtext' + (d.err ? ' bad' : '') + '">' + esc(d.out) + '</pre>'
      if (d.cut) h += '<div class="fvnote">内容过长，只显示开头和结尾</div>'
      if (d.out || d.input) { el.fvAct.hidden = false; el.fvAct.onclick = function () { copy(d.out || d.input) } }
    } else if (d.kind === 'dir') {
      el.fvSub.textContent = d.rel ? '/' + d.rel : '工作区根目录'
      h += d.entries.length ? '<div class="grp fl">' + d.entries.map(function (x) {
        var media = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|flac)$/i.test(x.name)
        return '<button class="row" data-fe="' + esc(x.name) + '" data-dir="' + (x.dir ? 1 : '') + '"><span class="fic' + (x.dir ? ' d' : '') + '">' + ic(x.dir ? 'folder' : media ? 'image' : 'read', 's') + '</span><div class="mid"><div class="t">' + esc(x.name) +
          '</div><div class="m">' + (x.dir ? '文件夹' : fsize(x.size)) + ' · ' + when(x.at) + '</div></div>' + (x.dir ? ic('chev', 's') : '') + '</button>'
      }).join('') + '</div>' : '<div class="empty"><b>空文件夹</b></div>'
      if (d.more) h += '<div class="fvnote">文件太多，只列出前 500 个</div>'
    } else {
      el.fvSub.textContent = fsize(d.size) + ' · ' + when(d.at) + (d.enc && d.enc !== 'utf-8' ? ' · ' + d.enc.toUpperCase() : '')
      h += '<div class="tacts fvchips"><button data-fdir="' + esc(dirName(d.rel)) + '">' + ic('folder', 's') + '<span>所在文件夹</span></button></div>'
      if (d.kind === 'media') {
        var u = rawUrl(en.s, d.rel)
        if (/^image\//.test(d.type)) h += '<img class="fvimg" src="' + esc(u) + '" alt="">'
        else if (/^video\//.test(d.type)) h += '<video class="fvmedia" controls playsinline preload="metadata" src="' + esc(u) + '"></video>'
        else h += '<audio class="fvmedia" controls preload="metadata" src="' + esc(u) + '"></audio>'
      } else if (d.kind === 'binary') {
        h += '<div class="empty"><b>无法预览</b>这是二进制文件（' + fsize(d.size) + '）</div>'
      } else {
        var isMd = /\.(md|markdown)$/i.test(d.name)
        if (isMd) h += '<div class="seg"><button class="' + (en.src ? '' : 'on') + '" data-mdv="0">预览</button><button class="' + (en.src ? 'on' : '') + '" data-mdv="1">源码</button></div>'
        h += isMd && !en.src ? '<div class="md fvmd">' + md(d.text) + '</div>' : '<pre class="fvtext">' + esc(d.text) + '</pre>'
        if (d.truncated) h += '<div class="fvnote">文件较大，只显示前 1 MB</div>'
        el.fvAct.hidden = false
        el.fvAct.onclick = function () { copy(d.text) }
      }
    }
    el.fvBody.innerHTML = h
  }

  // Line diff for the edit card: LCS over lines, unchanged runs folded to 3
  // lines of context. Big inputs fall back to "all old, then all new".
  function lineDiff(a, b) {
    var n = a.length, m = b.length, out = []
    if (n * m > 4e6) {
      a.forEach(function (s) { out.push(['-', s]) })
      b.forEach(function (s) { out.push(['+', s]) })
      return out
    }
    var w = m + 1, L = new Uint32Array((n + 1) * w)
    for (var i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--) L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1])
    i = 0; j = 0
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push([' ', a[i]]); i++; j++ }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) out.push(['-', a[i++]])
      else out.push(['+', b[j++]])
    }
    while (i < n) out.push(['-', a[i++]])
    while (j < m) out.push(['+', b[j++]])
    return out
  }
  function diffHtml(x) {
    var a = x.oldText == null ? [] : String(x.oldText).replace(/\r\n/g, '\n').split('\n')
    var b = x.newText == null ? [] : String(x.newText).replace(/\r\n/g, '\n').split('\n')
    var rows = lineDiff(a, b), keep = new Array(rows.length), adds = 0, dels = 0
    rows.forEach(function (r, k) {
      if (r[0] === '+') adds++
      if (r[0] === '-') dels++
      if (r[0] !== ' ') for (var q = Math.max(0, k - 3); q <= Math.min(rows.length - 1, k + 3); q++) keep[q] = true
    })
    var h = '', skipped = []
    function line(r) { h += '<span class="l ' + (r[0] === '+' ? 'add' : r[0] === '-' ? 'del' : 'ctx') + '" data-m="' + r[0] + '">' + (esc(r[1]) || ' ') + '</span>' }
    // Fold only runs worth folding; a marker for one or two lines costs more than it saves.
    function flushSkip() {
      if (skipped.length >= 4) h += '<span class="l skip">⋯ ' + skipped.length + ' 行未改动 ⋯</span>'
      else skipped.forEach(line)
      skipped = []
    }
    rows.forEach(function (r, k) {
      if (!keep[k] && rows.length > 12) { skipped.push(r); return }
      flushSkip()
      line(r)
    })
    flushSkip()
    var tag = x.oldText == null ? '新建' : x.newText == null ? '删除' : '修改'
    return '<div class="diff"><button class="dh" data-fp="' + esc(x.path || '') + '"><b>' + tag + '</b><span>' + esc(x.path || '') + '</span><em class="ok">+' + adds + '</em><em class="bad">−' + dels + '</em></button><pre>' + h + '</pre></div>'
  }

  // ------------------------------------------------------------ chat: data
  function loadHistory(c) {
    c.loading = true
    c.err = false
    c.buf = []
    if (c.id === S.cur) renderMsgs(c)
    return get((isAgent(c.id) ? '/m/api/agents/history?s=' : '/m/api/history?s=') + enc(c.id) + '&n=40').then(function (v) {
      c.items = v.items
      c.partial = v.partial
      c.lastSeq = v.lastSeq
      c.firstSeq = v.firstSeq
      c.hasMore = v.hasMore
      if (v.todos) c.todos = v.todos
      if (v.title) setTitle(c.id, v.title)
      c.loaded = true
    }, function (e) {
      c.err = true
      if (c.id === S.cur) toast(e.message, 'err')
    }).then(function () {
      c.loading = false
      var buf = c.buf
      c.buf = []
      buf.forEach(function (f) { apply(c, f) })
      if (c.id === S.cur) { renderMsgs(c, true); drawDock() }
    })
  }
  function loadOlder(c) {
    if (c.olderLoading || !c.hasMore) return
    c.olderLoading = true
    renderMsgs(c, false, true)
    get('/m/api/history?s=' + enc(c.id) + '&n=40&before=' + c.firstSeq).then(function (v) {
      var h0 = el.scroller.scrollHeight, t0 = el.scroller.scrollTop
      c.items = v.items.concat(c.items)
      if (v.firstSeq >= 0) c.firstSeq = v.firstSeq
      c.hasMore = v.hasMore
      c.olderLoading = false
      renderMsgs(c, false, true)
      el.scroller.scrollTop = t0 + (el.scroller.scrollHeight - h0)
    }, function (e) {
      c.olderLoading = false
      renderMsgs(c, false, true)
      toast(e.message, 'err')
    })
  }
  function loadModel(c) {
    if (c.models || c.modelLoading) return
    c.modelLoading = true
    rpc('session.models', { sessionId: c.id }).then(function (v) {
      c.models = v
      c.model = v.current
      if (c.id === S.cur) renderHead()
    }, function () {}).then(function () { c.modelLoading = false })
  }
  function modelName(c) {
    var cur = c.model
    if (!cur) return ''
    var name = cur.model, eff = cur.reasoningEffort
    ;(c.models ? c.models.groups : []).forEach(function (g) {
      if (g.id !== cur.provider) return
      g.models.forEach(function (m) {
        if (m.id !== cur.model) return
        name = m.name
        if (eff && m.reasoning) m.reasoning.efforts.forEach(function (e) { if (e.id === eff) eff = EFF[e.id] || e.name })
      })
    })
    return name + (eff ? ' · ' + (EFF[eff] || eff) : '')
  }
  var EFF = { off: '不思考', low: '低', medium: '中', high: '高', max: '最大' }

  // ------------------------------------------------------------ chat: live frames
  function onFrame(f) {
    switch (f.t) {
      case 'p': return
      case 'hello':
        S.hellos++
        setStatus('online')
        S.asks.clear()
        S.qs.clear()
        if (S.hellos > 1) resync()
        loadAgents()
        scheduleHome()
        return
      case 'run': return setRun(f.s, f.on)
      case 'list': return scheduleBoot()
      case 'agents': return scheduleAgents()
      case 'title': return setTitle(f.s, f.title)
      case 'ask': S.asks.set(f.id, f); buzz(30); return onPending(f.s)
      case 'askDone': { var a = S.asks.get(f.id); S.asks.delete(f.id); return onPending((a && a.s) || f.s) }
      case 'q': S.qs.set(f.rpc, f); buzz(30); return onPending(f.s)
      case 'qDone': { var q = S.qs.get(f.rpc); S.qs.delete(f.rpc); return onPending((q && q.s) || f.s) }
      case 'agentErr': if (f.s === S.cur) toast(f.msg || '运行出错', 'err'); return
      case 'err': return
    }
    var c = S.chats.get(f.s)
    if (!c) return
    if (c.loading) { c.buf.push(f); return }
    if (!c.loaded) return
    apply(c, f)
  }
  function onPending(s) {
    scheduleHome()
    if (s === S.cur) drawDock()
  }
  function ensurePartial(c) { return c.partial || (c.partial = { text: '', think: false, tool: null }) }
  function fresh(c, seq) {
    if (seq <= c.lastSeq) return false
    c.lastSeq = seq
    return true
  }
  function apply(c, f) {
    switch (f.t) {
      case 'd': {
        var add = ''
        f.p.forEach(function (x) { if (x[0] > c.lastSeq) { add += x[1]; c.lastSeq = x[0] } })
        if (add) { var p = ensurePartial(c); p.text += add; p.tool = null; drawPartial(c) }
        return
      }
      case 'think': if (fresh(c, f.seq)) { ensurePartial(c).think = true; drawPartial(c) } return
      case 'tooling': if (fresh(c, f.seq)) { ensurePartial(c).tool = f.name; drawPartial(c) } return
      case 'step': if (fresh(c, f.seq)) { c.partial = null; drawPartial(c) } return
      case 'turn': if (fresh(c, f.seq)) { S.run.add(c.id); drawPartial(c) } return
      case 'final':
        if (!fresh(c, f.seq)) return
        c.partial = null
        if (f.it) c.items.push(f.it)
        draw(c)
        return
      case 'item': {
        var it = f.it
        if (!it || !fresh(c, it.seq)) return
        if (it.k === 'u') {
          var i = -1
          c.pending.forEach(function (p, j) { if (i < 0 && p.rid && p.rid === it.rid) i = j })
          if (i >= 0) c.pending.splice(i, 1)
          touch(c.id)
        }
        if (it.k === 'end') { c.partial = null; touch(c.id) }
        c.items.push(it)
        draw(c)
        return
      }
      case 'result': {
        if (!fresh(c, f.seq)) return
        for (var k = c.items.length - 1; k >= 0; k--) {
          var t = c.items[k]
          if (t.k === 't' && t.id === f.id) {
            t.done = true; t.err = f.err; t.out = f.out; t.rseq = f.seq
            if (f.more) t.more = true
            if (f.paths) t.paths = (t.paths || []).concat(f.paths.filter(function (p) { return !t.paths || t.paths.indexOf(p) < 0 }))
            break
          }
        }
        draw(c)
        return
      }
      case 'todo': c.todos = f.todos; if (c.id === S.cur) drawDock(); return
      case 'queue': c.queue = f.items || []; if (c.id === S.cur) drawDock(); return
    }
  }
  function resync() {
    loadBoot().catch(function () {})
    S.chats.forEach(function (c) {
      if (c.id === S.cur) loadHistory(c)
      else { c.loaded = false; c.partial = null }
    })
  }

  // ------------------------------------------------------------ chat: rendering
  function nearBottom() { var s = el.scroller; return s.scrollHeight - s.scrollTop - s.clientHeight < 90 }
  function toBottom() { el.scroller.scrollTop = el.scroller.scrollHeight }
  var msgRaf = 0, tailRaf = 0
  function draw(c) {
    if (c.id !== S.cur || msgRaf) return
    msgRaf = requestAnimationFrame(function () { msgRaf = 0; renderMsgs(c) })
  }
  function drawPartial(c) {
    if (c.id !== S.cur || tailRaf) return
    tailRaf = requestAnimationFrame(function () {
      tailRaf = 0
      var stick = nearBottom()
      drawTail(c)
      if (stick) toBottom()
    })
  }
  function renderHead() {
    var c = S.chats.get(S.cur)
    if (!c) return
    var s = S.byId[c.id], ag = isAgent(c.id) && agentOf(c.id)
    el.cTitle.textContent = (ag && (ag.title || ag.project)) || (s && s.title) || c.title || (isAgent(c.id) ? '外部会话' : '新对话')
    var sub = ''
    if (S.status !== 'online') sub += (S.status === 'offline' ? '电脑离线' : '连接中…') + ' · '
    else if (isRunning(c.id)) sub += '<span class="live"><span class="spin s"></span>运行中</span> · '
    if (isAgent(c.id)) sub += esc(ag ? ag.name + (ag.project ? ' · ' + ag.project : '') : '')
    else sub += esc(wsTitle(wsOf(c.id)))
    if (c.model && !isAgent(c.id)) sub += ' · ' + esc(modelName(c))
    if (s && s.cx >= 70) sub += ' · <span class="warn">上下文 ' + s.cx + '%</span>'
    el.cSub.innerHTML = sub
  }
  function userHtml(c, it) {
    var imgs = (it.imgs || []).map(function (im) {
      return '<img loading="lazy" data-view src="' + esc(im.url || imgUrl(c.id, im.id)) + '" alt="">'
    }).join('')
    return '<div class="u' + (it.pending ? ' pending' : '') + '">' + (imgs ? '<div class="imgs">' + imgs + '</div>' : '') + (it.text ? '<div class="bub">' + esc(it.text) + '</div>' : '') + '</div>'
  }
  function asstHtml(it) {
    var h = '<div class="a">'
    if (it.think) {
      h += '<button class="think" data-think="' + it.seq + '">' + ic('bulb', 's') + '思考过程' + ic(it._t ? 'down' : 'chev', 's') + '</button>'
      if (it._t) h += '<div class="think-body">' + esc(it.think) + '</div>'
    }
    if (it.text) {
      h += '<div class="md">' + (it._h || (it._h = md(it.text))) + '</div>'
      if (it._fin) h += '<div class="acts"><button data-copymsg="' + it.seq + '">' + ic('copy', 's') + '复制</button></div>'
    }
    return h + '</div>'
  }
  function toolRow(t) {
    var st = t.err ? ic('xc', 's st bad') : t.done ? ic('checkc', 's st') : t._spin ? '<span class="spin s"></span>' : ''
    var body = ''
    if (t._o) {
      if (t.detail && t.detail !== t.title) body += '<pre>' + esc(t.detail) + '</pre>'
      if (t.out) body += '<pre class="out' + (t.err ? ' bad' : '') + '">' + esc(t.out) + '</pre>'
      var acts = (t.more ? '<button data-full="' + esc(t.id) + '">' + ic('read', 's') + '<span>完整内容</span></button>' : '') + chipsHtml(t.paths, wsRoot(S.cur))
      if (acts) body += '<div class="tacts">' + acts + '</div>'
    }
    return '<div class="tr' + (t._o ? ' o' : '') + '"><button class="trh" data-tool="' + esc(t.id) + '">' + ic(KI[t.kind] || 'other', 's') + '<span>' + esc(t.title) + '</span>' + st + '</button>' + body + '</div>'
  }
  function toolsHtml(c, arr) {
    if (arr.length === 1) return '<div class="tools single">' + toolRow(arr[0]) + '</div>'
    var key = arr[0].seq, open = c.open.has(key)
    var kinds = [], errs = 0, spin = false
    arr.forEach(function (t) {
      var k = KI[t.kind] || 'other'
      if (kinds.indexOf(k) < 0 && kinds.length < 4) kinds.push(k)
      if (t.err) errs++
      if (t._spin) spin = true
    })
    var last = arr[arr.length - 1]
    return '<div class="tools' + (open ? ' o' : '') + '"><button class="tg" data-group="' + key + '"><span class="kinds">' + kinds.map(function (k) { return ic(k, 's') }).join('') +
      '</span><span class="n">' + arr.length + ' 个操作</span>' + (errs ? '<span class="bad">' + errs + ' 失败</span>' : '') +
      '<span class="last">' + (open ? '' : esc(last.title)) + '</span>' + (spin ? '<span class="spin s"></span>' : '') + ic('chev', 's chev') + '</button>' +
      (open ? arr.map(toolRow).join('') : '') + '</div>'
  }
  var END = { completed: '完成', interrupted: '已中断', aborted: '已停止', cancelled: '已停止', error: '出错', failed: '出错' }
  function endHtml(it) {
    var bad = it.reason === 'error' || it.reason === 'failed'
    return '<div class="end' + (bad ? ' bad' : '') + '">' + esc(END[it.reason] || it.reason) + (it.ms ? ' · ' + dur(it.ms) : '') + '</div>'
  }
  function renderMsgs(c, jump, keep) {
    if (c.id !== S.cur) return
    var stick = jump || (!keep && nearBottom())
    if (!c.loaded) {
      el.older.innerHTML = ''
      el.msgs.innerHTML = c.err && !c.loading ? '<div class="hint"><b>加载失败</b><button class="link" data-retry>重试</button></div>' : '<div class="spin"></div>'
      el.tail.innerHTML = ''
      return
    }
    el.older.innerHTML = c.hasMore ? '<button data-older>' + (c.olderLoading ? '加载中…' : '查看更早的消息') + '</button>' : ''
    var running = isRunning(c.id), lastEnd = -1
    c.items.forEach(function (it, i) { if (it.k === 'end') lastEnd = i })
    c.items.forEach(function (it, i) { if (it.k === 't') it._spin = running && !it.done && i > lastEnd })
    // Copy action only under each turn's final answer, not every interim note.
    var lastA = null
    c.items.forEach(function (it) {
      if (it.k === 'a') { if (lastA) lastA._fin = false; lastA = it; it._fin = false }
      else if (it.k === 'end' || it.k === 'u') { if (lastA) lastA._fin = true; lastA = null }
    })
    if (lastA) lastA._fin = !running
    var h = '', group = []
    function flush() { if (group.length) { h += toolsHtml(c, group); group = [] } }
    c.items.forEach(function (it) {
      if (it.k === 't') { group.push(it); return }
      flush()
      if (it.k === 'u') h += userHtml(c, it)
      else if (it.k === 'a') h += asstHtml(it)
      else if (it.k === 'end') h += endHtml(it)
    })
    flush()
    c.pending.forEach(function (p) { h += userHtml(c, p) })
    if (!h && isAgent(c.id)) { var ag = agentOf(c.id); h = '<div class="hint"><b>' + esc(ag ? ag.project || ag.name : '外部会话') + '</b>这个会话的记录会出现在这里，也可以从手机继续它</div>' }
    if (!h) h = '<div class="hint"><b>' + esc(wsTitle(wsOf(c.id))) + '</b>发一条消息开始</div>'
    el.msgs.innerHTML = h
    drawTail(c)
    if (stick) toBottom()
    el.toBottom.hidden = nearBottom()
  }
  function lastToolSpinning(c) {
    for (var i = c.items.length - 1; i >= 0; i--) { var it = c.items[i]; if (it.k === 't') return Boolean(it._spin); if (it.k !== 'end') return false }
    return false
  }
  function drawTail(c) {
    var p = c.partial, h = ''
    if (p && p.text) h = '<div class="a"><div class="md">' + withCursor(md(p.text)) + '</div></div>'
    else if (p && p.tool) h = '<div class="typing"><span class="spin s"></span>正在' + esc(toolLabel(p.tool)) + '…</div>'
    else if (p && p.think) h = '<div class="typing"><span class="dots"><i></i><i></i><i></i></span>思考中</div>'
    else if (isRunning(c.id) && c.loaded && !lastToolSpinning(c)) h = '<div class="typing"><span class="dots"><i></i><i></i><i></i></span></div>'
    el.tail.innerHTML = h
  }

  // ------------------------------------------------------------ dock
  function askHtml(c, a) {
    var t = null
    if (a.call) for (var i = c.items.length - 1; i >= 0; i--) if (c.items[i].k === 't' && c.items[i].id === a.call) { t = c.items[i]; break }
    var title = a.title || (t && t.title) || toolLabel(a.tool)
    var detail = a.detail || (t && t.detail) || ''
    return '<div class="card ask"><div class="ch"><i class="dotw"></i>需要你确认<span class="x">' + esc(toolLabel(a.tool)) + '</span></div>' +
      '<div class="ct">' + esc(title) + '</div>' + (a.why ? '<div class="cw">' + esc(a.why) + '</div>' : '') +
      (detail && detail !== title ? '<pre>' + esc(detail) + '</pre>' : '') +
      '<div class="btns"><button class="btn danger" data-deny="' + esc(a.id) + '">拒绝</button>' +
      (a.remember ? '<button class="btn" data-remember="' + esc(a.id) + '">允许并记住</button>' : '') +
      '<button class="btn pri" data-allow="' + esc(a.id) + '">' + ic('check', 's') + '允许</button></div>' +
      (a.remember ? '<div class="cw">"允许并记住"：这个会话里同类操作不再询问</div>' : '') + '</div>'
  }
  function qHtml(q) {
    var sel = q._sel || (q._sel = {}), custom = q._custom || (q._custom = {})
    var plan = null
    var body = (q.qs || []).map(function (it, ii) {
      if (it.intent && it.intent.kind === 'plan-review') plan = it.intent
      var chosen = sel[it.id] || []
      var opts = (it.options || []).map(function (o, oi) {
        return '<button class="opt' + (chosen.indexOf(o.label) >= 0 ? ' on' : '') + '" data-qo="' + ii + ':' + oi + '">' + esc(o.label) + (o.description ? '<small>' + esc(o.description) + '</small>' : '') + '</button>'
      }).join('')
      return '<div class="qq">' + (it.header ? '<div class="qh">' + esc(it.header) + '</div>' : '') + '<div class="qt">' + esc(it.question) + '</div>' +
        (it.detail ? '<div class="qd">' + esc(it.detail) + '</div>' : '') + (opts ? '<div class="opts">' + opts + '</div>' : '') +
        '<input class="qin" data-qi="' + ii + '" placeholder="' + (opts ? '或者自己写…' : '输入回答…') + '" value="' + esc(custom[it.id] || '') + '"></div>'
    }).join('')
    return '<div class="card" data-q="' + esc(q.rpc) + '"><div class="ch q"><i class="dotw"></i>DSH 在问你</div>' + body +
      '<div class="btns"><button class="btn" data-qcancel>取消</button><button class="btn pri" data-qsubmit>' + esc(plan ? plan.approve || '批准' : '提交') + '</button></div></div>'
  }
  function todoHtml(c) {
    var t = c.todos, done = 0, cur = null
    t.forEach(function (x) { if (x.status === 'completed') done++; else if (!cur || (x.status === 'in_progress' && cur.status !== 'in_progress')) cur = x })
    if (done === t.length && !isRunning(c.id)) return ''
    if (!c.todoOpen) {
      return '<button class="pill" data-todo>' + ic(done === t.length ? 'checkc' : 'dotc', 's') + '<b>进度 ' + done + '/' + t.length + '</b><span>' + esc(cur ? cur.content : '全部完成') +
        '</span><span class="bar-p"><i style="width:' + Math.round((done / t.length) * 100) + '%"></i></span></button>'
    }
    return '<div class="card todos" data-todo>' + t.map(function (x) {
      return '<div class="todo ' + esc(x.status) + '">' + ic(x.status === 'completed' ? 'checkc' : x.status === 'in_progress' ? 'dotc' : 'circle', 's') + '<span>' + esc(x.content) + '</span></div>'
    }).join('') + '</div>'
  }
  var dockDirty = false
  function drawDock() {
    var c = S.cur && S.chats.get(S.cur)
    if (!c) { el.dock.innerHTML = ''; return }
    // Hold re-renders only while the user is typing into a dock input; a
    // focused button must not block its own selection state from painting.
    var ae = document.activeElement
    if (ae && el.dock.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) { dockDirty = true; return }
    dockDirty = false
    var h = ''
    S.asks.forEach(function (a) { if (a.s === c.id) h += askHtml(c, a) })
    S.qs.forEach(function (q) { if (q.s === c.id) h += qHtml(q) })
    ;(c.queue || []).forEach(function (x) {
      h += '<div class="qitem">' + ic('send', 's') + '<span>' + esc(x.text || '图片') + '</span><em>' + (x.place === 'steering' ? '插入中' : '排队中') + '</em><button data-unqueue="' + esc(x.id) + '" aria-label="撤回">' + ic('x', 's') + '</button></div>'
    })
    if (c.todos && c.todos.length) h += todoHtml(c)
    el.dock.innerHTML = h
  }

  // ------------------------------------------------------------ composer
  function autosize() {
    el.input.style.height = 'auto'
    el.input.style.height = Math.min(150, el.input.scrollHeight) + 'px'
  }
  function syncSend() {
    if (S.cur && isAgent(S.cur)) {
      // No stop button: a turn running on the PC is stopped there.
      el.send.className = 'send'
      el.send.innerHTML = ic('send')
      el.send.disabled = !el.input.value.trim() || isRunning(S.cur)
      el.send.setAttribute('aria-label', '发送')
      return
    }
    var has = el.input.value.trim() || S.att.length
    if (S.cur && isRunning(S.cur) && !has) {
      el.send.className = 'send stop'
      el.send.innerHTML = ic('stop')
      el.send.disabled = false
      el.send.setAttribute('aria-label', '停止')
    } else {
      el.send.className = 'send'
      el.send.innerHTML = ic('send')
      el.send.disabled = !has
      el.send.setAttribute('aria-label', '发送')
    }
  }
  function drawThumbs() {
    el.thumbs.hidden = !S.att.length
    el.thumbs.innerHTML = S.att.map(function (a, i) { return '<div class="th"><img src="' + esc(a.url) + '" alt=""><button data-rm="' + i + '" aria-label="移除">' + ic('x') + '</button></div>' }).join('')
  }
  function prepImage(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image()
      img.onload = function () {
        var k = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight))
        var w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k)
        var cv = document.createElement('canvas')
        cv.width = w; cv.height = h
        var g = cv.getContext('2d')
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h)
        var data = cv.toDataURL('image/jpeg', 0.86)
        res({ url: url, b64: data.slice(data.indexOf(',') + 1), type: 'image/jpeg', name: String(file.name || 'photo').replace(/\.\w+$/, '') + '.jpg' })
      }
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('无法读取图片')) }
      img.src = url
    })
  }
  function sendAgent(c) {
    var text = el.input.value.trim()
    if (!text || isRunning(c.id)) return
    el.send.disabled = true
    buzz(8)
    post('/m/api/agents/prompt', { s: c.id, text: text }).then(function () {
      el.input.value = ''
      delete S.drafts[c.id]
      store.set('drafts', S.drafts)
      autosize()
      toast('已发到电脑，后台开始运行')
      loadAgents()
      setTimeout(function () { if (S.cur === c.id) loadHistory(c) }, 3000)
    }, function (e) { syncSend(); toast('没发出去：' + e.message, 'err') })
  }
  function send() {
    var c = S.cur && S.chats.get(S.cur)
    if (!c) return
    if (isAgent(c.id)) { sendAgent(c); return }
    var text = el.input.value.trim(), att = S.att
    if (!text && !att.length) return
    var rid = uuid(), content = []
    att.forEach(function (a) { content.push({ type: 'image', mediaType: a.type, data: a.b64, name: a.name }) })
    if (text) content.push({ type: 'text', text: text })
    var busy = isRunning(c.id)
    var pend = { k: 'u', rid: rid, text: text, imgs: att.map(function (a) { return { url: a.url } }), pending: true }
    if (!busy) { c.pending.push(pend); renderMsgs(c, true) }
    el.input.value = ''
    delete S.drafts[c.id]
    store.set('drafts', S.drafts)
    S.att = []
    drawThumbs(); autosize(); syncSend()
    buzz(8)
    rpc('session.prompt', { sessionId: c.id, mode: 'queue', content: content, clientTimeZone: TZ }, rid).then(function (v) {
      if (v && v.command) {
        c.pending = c.pending.filter(function (p) { return p !== pend })
        draw(c)
        toast(v.command.text || '命令已执行')
      } else if (!busy) {
        setRun(c.id, true)
        touch(c.id)
      }
    }, function (e) {
      c.pending = c.pending.filter(function (p) { return p !== pend })
      draw(c)
      if (!el.input.value) { el.input.value = text; autosize(); syncSend() }
      toast('没发出去：' + e.message, 'err')
    })
  }
  function stop() {
    var id = S.cur
    buzz(12)
    rpc('session.cancel', { sessionId: id }).then(function () { toast('已停止') }, function (e) { toast(e.message, 'err') })
  }

  // ------------------------------------------------------------ sheets
  function newSheet() {
    var pre = S.filter !== 'all' && S.filter !== 'none' ? S.filter : null
    openSheet('<div class="sh-h">新对话<small>选择在哪个工作区里干活</small></div><div class="sh-b">' + sortedWorkspaces().map(function (w) {
      return '<button class="opt-row' + (w.id === pre ? ' on' : '') + '" data-w="' + esc(w.id) + '"><span class="ico">' + ic('folder', 's') + '</span><span class="mid"><b>' + esc(w.title) + '</b><small>' + esc(w.path) + '</small></span>' + ic('chev', 's') + '</button>'
    }).join('') + '</div>')
    el.sheet.onclick = function (e) {
      var b = e.target.closest('[data-w]')
      if (!b || b.disabled) return
      b.disabled = true
      closeOverlay().then(function () { startChat(b.dataset.w) })
    }
  }
  function startChat(wid) {
    var reuse = S.blanks[wid]
    var p = reuse ? Promise.resolve({ sessionId: reuse }) : rpc('session.create', { workspaceId: wid })
    if (reuse) delete S.blanks[wid]
    p.then(function (v) {
      var c = chatState(v.sessionId)
      c.loaded = true
      c.w = wid
      S.chats.set(c.id, c)
      openChat(c.id)
      if (S.share) { fillShare(c.id, S.share); S.share = null }
      else setTimeout(function () { el.input.focus() }, 380)
    }, function (e) { toast('创建失败：' + e.message, 'err') })
  }
  function modelSheet() {
    var c = S.chats.get(S.cur)
    if (!c) return
    openSheet('<div class="sh-h">模型</div><div class="sh-b" id="mb"><div class="spin"></div></div>')
    var box = document.getElementById('mb')
    function paint() {
      var cur = c.model || {}, h = ''
      c.models.groups.forEach(function (g) {
        h += '<div class="sh-sec">' + esc(g.name) + '</div>'
        g.models.forEach(function (m) {
          var on = cur.provider === g.id && cur.model === m.id
          h += '<button class="opt-row' + (on ? ' on' : '') + '" data-p="' + esc(g.id) + '" data-m="' + esc(m.id) + '"><span class="ico">' + ic('cpu', 's') + '</span><span class="mid"><b>' + esc(m.name) + '</b>' +
            (m.description ? '<small>' + esc(m.description) + '</small>' : '') + '</span>' + (on ? ic('check', 'chk') : '') + '</button>'
          if (on && m.reasoning && m.reasoning.efforts.length) {
            var eff = cur.reasoningEffort || m.reasoning.defaultEffort
            h += '<div class="efforts">' + m.reasoning.efforts.map(function (e) { return '<button class="chip' + (eff === e.id ? ' on' : '') + '" data-e="' + esc(e.id) + '">' + esc(EFF[e.id] || e.name) + '</button>' }).join('') + '</div>'
          }
        })
      })
      ;(c.models.failures || []).forEach(function (f) { h += '<div class="sh-sec">' + esc(f.name) + ' · 暂不可用</div>' })
      box.innerHTML = h
    }
    rpc('session.models', { sessionId: c.id }).then(function (v) { c.models = v; c.model = v.current; renderHead(); paint() }, function (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>' })
    el.sheet.onclick = function (e) {
      var b = e.target.closest('[data-m],[data-e]')
      if (!b || !c.models) return
      var cur = c.model || {}, sel
      if (b.dataset.e) sel = { provider: cur.provider, model: cur.model, reasoningEffort: b.dataset.e }
      else {
        var g = c.models.groups.filter(function (x) { return x.id === b.dataset.p })[0]
        var m = g && g.models.filter(function (x) { return x.id === b.dataset.m })[0]
        if (!m) return
        sel = { provider: g.id, model: m.id }
        if (m.reasoning) {
          var keep = m.reasoning.efforts.some(function (x) { return x.id === cur.reasoningEffort }) ? cur.reasoningEffort : m.reasoning.defaultEffort
          if (keep) sel.reasoningEffort = keep
        }
      }
      rpc('session.selectModel', Object.assign({ sessionId: c.id }, sel)).then(function (r) { c.model = r.selected; buzz(); paint(); renderHead() }, function (err) { toast(err.message, 'err') })
    }
  }
  function agentMoreSheet(c) {
    var ag = agentOf(c.id)
    openSheet('<div class="sh-h">' + esc(el.cTitle.textContent) + '<small>' + esc(ag ? ag.cwd || '' : '') + '</small></div><div class="sh-b">' +
      '<button class="opt-row" data-a="files"><span class="ico">' + ic('folder', 's') + '</span><span class="mid"><b>项目文件</b><small>' + esc(ag ? ag.project : '') + '</small></span>' + ic('chev', 's') + '</button>' +
      '<button class="opt-row" data-a="mode"><span class="ico">' + ic('alert', 's') + '</span><span class="mid"><b>确认请求发到哪里</b><small>' + esc(MODE_NAME[S.agents.mode] || '') + '</small></span>' + ic('chev', 's') + '</button></div>')
    el.sheet.onclick = function (e) {
      var b = e.target.closest('[data-a]')
      if (!b) return
      closeOverlay().then(function () {
        if (b.dataset.a === 'files') fvOpen({ kind: 'path', s: c.id, path: '', title: (ag && ag.project) || '项目' })
        else modeSheet()
      })
    }
  }
  function moreSheet() {
    var c = S.chats.get(S.cur)
    if (!c) return
    if (isAgent(c.id)) { agentMoreSheet(c); return }
    openSheet('<div class="sh-h">' + esc(el.cTitle.textContent) + '</div><div class="sh-b">' +
      '<button class="opt-row" data-a="model"><span class="ico">' + ic('cpu', 's') + '</span><span class="mid"><b>切换模型</b><small>' + esc(modelName(c) || '当前模型') + '</small></span>' + ic('chev', 's') + '</button>' +
      '<button class="opt-row" data-a="files"><span class="ico">' + ic('folder', 's') + '</span><span class="mid"><b>工作区文件</b><small>' + esc(wsTitle(wsOf(c.id))) + '</small></span>' + ic('chev', 's') + '</button>' +
      '<button class="opt-row" data-a="usage"><span class="ico">' + ic('stats', 's') + '</span><span class="mid"><b>用量</b><small>token、缓存命中、上下文占用、耗时</small></span>' + ic('chev', 's') + '</button>' +
      '<button class="opt-row" data-a="rename"><span class="ico">' + ic('pen', 's') + '</span><span class="mid"><b>重命名</b></span></button>' +
      '<button class="opt-row danger" data-a="archive"><span class="ico">' + ic('archive', 's') + '</span><span class="mid"><b>归档对话</b><small>从列表隐藏，记录仍保存在电脑上</small></span></button></div>')
    el.sheet.onclick = function (e) {
      var b = e.target.closest('[data-a]')
      if (!b) return
      var a = b.dataset.a
      if (a === 'archive' && !b.dataset.sure) { b.dataset.sure = '1'; b.querySelector('b').textContent = '再点一次确认归档'; buzz(); return }
      closeOverlay().then(function () {
        if (a === 'model') modelSheet()
        else if (a === 'files') fvOpen({ kind: 'path', s: c.id, path: '', title: wsTitle(wsOf(c.id)) || '工作区' })
        else if (a === 'rename') renameSheet()
        else if (a === 'usage') usageSheet(c)
        else if (a === 'archive') archive(c.id)
      })
    }
  }
  function renameSheet() {
    var c = S.chats.get(S.cur)
    if (!c) return
    openSheet('<div class="sh-h">重命名</div><div class="sh-in"><input id="rn" maxlength="80" enterkeyhint="done" value="' + esc(el.cTitle.textContent) + '"><div class="btns"><button class="btn" data-x>取消</button><button class="btn pri" data-ok>保存</button></div></div>')
    var inp = document.getElementById('rn')
    setTimeout(function () { inp.focus(); inp.select() }, 360)
    function save() {
      var t = inp.value.trim()
      if (!t) return
      rpc('session.rename', { sessionId: c.id, title: t }).then(function (r) { setTitle(c.id, r.title); closeOverlay() }, function (e) { toast(e.message, 'err') })
    }
    inp.onkeydown = function (e) { if (e.key === 'Enter') save() }
    el.sheet.onclick = function (e) {
      if (e.target.closest('[data-x]')) closeOverlay()
      else if (e.target.closest('[data-ok]')) save()
    }
  }
  // ------------------------------------------------------------ quick commands
  // Short prompts kept on the PC (commands.json) and shared by every phone. A tap
  // only fills the composer: the user still reads it and presses send.
  var cmdCache = null
  function loadCmds() {
    if (cmdCache && Date.now() - cmdCache.at < 60000) return Promise.resolve(cmdCache.v)
    return get('/m/api/commands').then(function (v) { cmdCache = { at: Date.now(), v: v }; return v })
  }
  function quickSheet() {
    var v = null, edit = false
    openSheet('<div class="sh-h">快捷指令<small>存在电脑上，所有手机共用；点一条填进输入框</small></div><div class="sh-b" id="qc"><div class="spin"></div></div>')
    var box = document.getElementById('qc')
    function row(c) {
      var inner = '<span class="ico">' + ic('zap', 's') + '</span><span class="mid"><b>' + esc(c.label) + '</b><small>' + esc(c.text) + '</small></span>'
      return edit
        ? '<div class="opt-row">' + inner + '<button class="ib del" data-del="' + esc(c.id) + '" aria-label="删除 ' + esc(c.label) + '">' + ic('delete', 's') + '</button></div>'
        : '<button class="opt-row" data-cmd="' + esc(c.id) + '">' + inner + '</button>'
    }
    function paint() {
      var h = v.note ? '<div class="qc-note">' + esc(v.note) + '</div>' : ''
      if (!v.items.length) h += '<div class="qc-note">还没有快捷指令，点下面添加。</div>'
      h += v.items.map(row).join('')
      h += edit
        ? '<div class="sh-sec">添加一条</div><div class="sh-in"><input id="qcL" maxlength="16" placeholder="名称，例如：跑测试" enterkeyhint="next">' +
          '<textarea id="qcT" maxlength="2000" rows="3" placeholder="要发给它的话"></textarea>' +
          '<div class="btns"><button class="btn" data-done>完成</button><button class="btn pri" data-add>添加</button></div></div>'
        : '<div class="sh-in"><div class="btns"><button class="btn" data-edit>管理指令</button></div></div>'
      box.innerHTML = h
    }
    function save(items) {
      return post('/m/api/commands', { items: items }).then(function (r) { v = r; cmdCache = { at: Date.now(), v: r }; paint(); buzz() }, function (e) { toast(e.message, 'err') })
    }
    loadCmds().then(function (r) { v = r; paint() }, function (e) { box.innerHTML = '<div class="qc-note">' + esc(e.message) + '</div>' })
    el.sheet.onclick = function (e) {
      if (!v) return
      var b
      if ((b = e.target.closest('[data-cmd]'))) {
        var c = v.items.filter(function (x) { return x.id === b.dataset.cmd })[0]
        if (!c) return
        var cur = el.input.value.replace(/\s+$/, '')
        el.input.value = cur ? cur + '\n' + c.text : c.text
        autosize(); syncSend(); saveDraft()
        closeOverlay()
        setTimeout(function () { el.input.focus() }, 360)
      } else if (e.target.closest('[data-edit]')) { edit = true; paint() }
      else if (e.target.closest('[data-done]')) { edit = false; paint() }
      else if ((b = e.target.closest('[data-del]'))) { save(v.items.filter(function (x) { return x.id !== b.dataset.del })) }
      else if (e.target.closest('[data-add]')) {
        var label = document.getElementById('qcL').value.trim(), text = document.getElementById('qcT').value.trim()
        if (!label || !text) { toast('名称和内容都要填'); return }
        save(v.items.concat([{ label: label, text: text }]))
      }
    }
  }
  // ------------------------------------------------------------ usage
  // DSH keeps per-session totals (tokens, time, context pressure); the plugin reads them from
  // session.list. They are cumulative per session, so "last 7 days" means sessions active then.
  function fmtTok(n) {
    n = n || 0
    if (n < 1000) return String(n)
    if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'K'
    return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'
  }
  function hitRate(u) { var t = (u.cacheRead || 0) + (u.in || 0); return t ? Math.round((u.cacheRead || 0) / t * 100) : null }
  function usageBrief(u) {
    var p = ['输出 ' + fmtTok(u.out)], h = hitRate(u)
    if (h !== null) p.push('缓存命中 ' + h + '%')
    if (u.ctxPct !== undefined) p.push('上下文 ' + u.ctxPct + '%')
    return p.join(' · ')
  }
  function kv(pairs) {
    return '<div class="kv">' + pairs.map(function (p) { return '<div><span>' + esc(p[0]) + '</span><b>' + esc(p[1]) + '</b></div>' }).join('') + '</div>'
  }
  function tokenPairs(u) {
    var h = hitRate(u), r = [['输入（未命中缓存）', fmtTok(u.in)], ['缓存命中', fmtTok(u.cacheRead) + (h !== null ? '（' + h + '%）' : '')], ['输出', fmtTok(u.out)]]
    if (u.cacheWrite) r.push(['缓存写入', fmtTok(u.cacheWrite)])
    return r
  }
  function usageSheet(c) {
    openSheet('<div class="sh-h">用量<small>这个会话累计，数据来自 DSH</small></div><div class="sh-b" id="us"><div class="spin"></div></div>')
    var box = document.getElementById('us')
    get('/m/api/usage?s=' + enc(c.id)).then(function (v) {
      var u = v.sessions[0] && v.sessions[0].u
      if (!u) { box.innerHTML = '<div class="qc-note">这个会话还没有用量数据。</div>'; return }
      var r = u.out !== undefined ? tokenPairs(u) : []
      if (u.ctxPct !== undefined) r.push(['上下文', u.ctxPct + '%（' + fmtTok(u.ctx) + ' / ' + fmtTok(u.window) + '）'])
      if (u.turns !== undefined) r.push(['回合 / 步数', u.turns + ' / ' + u.steps])
      if (u.llmMs) r.push(['模型耗时', dur(u.llmMs)])
      if (u.toolMs) r.push(['工具耗时（含等你确认）', dur(u.toolMs)])
      if (u.ttftMs) r.push(['平均首字', (u.ttftMs / 1000).toFixed(1) + ' 秒'])
      if (u.tps) r.push(['输出速度', u.tps + ' token/秒'])
      box.innerHTML = kv(r) + (u.ctxPct >= 70 ? '<div class="qc-note">上下文快满了：再聊下去模型会开始压缩或遗忘前面的内容，可以考虑开个新对话。</div>' : '')
    }, function (e) { box.innerHTML = '<div class="qc-note">' + esc(e.message) + '</div>' })
  }
  function weekSheet() {
    openSheet('<div class="sh-h">最近 7 天用量<small>这 7 天里有活动的会话，按会话累计；数据来自 DSH</small></div><div class="sh-b" id="us"><div class="spin"></div></div>')
    var box = document.getElementById('us')
    get('/m/api/usage?days=7').then(function (v) {
      var t = v.totals
      var h = kv([['会话 / 回合', t.sessions + ' / ' + t.turns]].concat(tokenPairs(t), [['模型耗时', dur(t.llmMs)]]))
      if (v.sessions.length) {
        h += '<div class="sh-sec">用得最多的会话</div>' + v.sessions.slice(0, 10).map(function (s) {
          return '<button class="opt-row" data-open="' + esc(s.id) + '"><span class="mid"><b>' + esc(s.title || '未命名对话') + '</b><small>' + esc(usageBrief(s.u)) + '</small></span>' + ic('chev', 's') + '</button>'
        }).join('')
      }
      box.innerHTML = h
    }, function (e) { box.innerHTML = '<div class="qc-note">' + esc(e.message) + '</div>' })
    el.sheet.onclick = function (e) {
      var b = e.target.closest('[data-open]')
      if (b) closeAllOverlays().then(function () { openChat(b.dataset.open) })
    }
  }
  function archive(id) {
    rpc('workspace.archiveSession', { sessionId: id }).then(function () {
      S.sessions = S.sessions.filter(function (s) { return s.id !== id })
      delete S.byId[id]
      toast('已归档')
      if (S.cur === id) history.back()
    }, function (e) { toast(e.message, 'err') })
  }

  // ------------------------------------------------------------ events (SSE)
  var es = null, lastBeat = 0, retry = 0, retryT = 0
  function connect() {
    clearTimeout(retryT)
    if (es) { es.close(); es = null }
    setStatus('connecting')
    var src = new EventSource('/m/api/events')
    es = src
    lastBeat = Date.now()
    src.onmessage = function (m) {
      if (es !== src) return
      lastBeat = Date.now()
      var f
      try { f = JSON.parse(m.data) } catch (e) { return }
      if (f.t === 'hello') retry = 0
      try { onFrame(f) } catch (e) { console.error(e) }
    }
    src.onerror = function () {
      if (es !== src) return
      if (src.readyState === 2) { es = null; setStatus('offline'); reconnectLater() } else setStatus('connecting')
    }
  }
  function reconnectLater() {
    retry = Math.min(retry + 1, 5)
    fetch('/m/api/ping', { redirect: 'manual', cache: 'no-store' }).then(function (r) {
      if (r.type === 'opaqueredirect' || r.status === 401) toLogin()
    }, function () {})
    retryT = setTimeout(connect, 1000 * Math.min(15, Math.pow(2, retry)))
  }
  setInterval(function () {
    if (document.visibilityState === 'visible' && es && Date.now() - lastBeat > 40000) connect()
  }, 10000)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') { saveDraft(); return }
    if (!es || Date.now() - lastBeat > 25000) connect()
    else scheduleHome()
  })

  // ------------------------------------------------------------ wiring
  document.querySelectorAll('[data-ic]').forEach(function (n) { n.innerHTML = ic(n.dataset.ic) })
  el.status.lastChild.textContent = '连接中'

  el.rows.addEventListener('click', function (e) {
    if (e.target.closest('[data-mode]')) { modeSheet(); return }
    if (e.target.closest('[data-update]')) { buzz(); location.href = 'dshapp://update'; return }
    var b = e.target.closest('[data-open]')
    if (b) openChat(b.dataset.open)
  })
  el.chips.addEventListener('click', function (e) {
    var b = e.target.closest('[data-f]')
    if (!b) return
    S.filter = b.dataset.f
    store.set('filter', S.filter)
    renderHome()
    el.list.scrollTop = 0
  })
  // Connection sheet: where this client points, reconnect, and (inside the
  // Android shell) switch to another server.
  var IN_APP = /DSHApp\//.test(navigator.userAgent)

  // Web Push for the installed web app (iPhone: "Add to Home Screen", iOS
  // 16.4+). The Android app has native notifications and skips all of this.
  var STANDALONE = navigator.standalone === true || Boolean(window.matchMedia && matchMedia('(display-mode: standalone)').matches)
  var IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  if (!IN_APP && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' }).catch(function () {})
    navigator.serviceWorker.addEventListener('message', function (e) { if (e.data && e.data.t === 'open') window.dshOpen(e.data.s) })
  }
  function swReady() {
    return Promise.race([navigator.serviceWorker.ready, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('后台服务没有启动')) }, 5000) })])
  }
  function pushState() {
    if (IN_APP) return Promise.resolve({ state: 'app' })
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return Promise.resolve({ state: IOS && !STANDALONE ? 'install' : 'unsupported' })
    if (Notification.permission === 'denied') return Promise.resolve({ state: 'denied' })
    return swReady().then(function (r) { return r.pushManager.getSubscription() }).then(function (sub) { return { state: sub ? 'on' : 'off', sub: sub } }, function () { return { state: 'unsupported' } })
  }
  function b64uBytes(s) {
    var b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), a = new Uint8Array(b.length)
    for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i)
    return a
  }
  function deviceLabel() { var u = navigator.userAgent; return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) || IOS ? 'iPad' : /Android/.test(u) ? 'Android 浏览器' : '电脑浏览器' }
  function enablePush() {
    // requestPermission comes first, still inside the tap: iOS only asks from a user gesture.
    return Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') throw new Error(perm === 'denied' ? '通知权限被拒绝了，请在系统设置里允许' : '没有允许通知')
      return Promise.all([swReady(), get('/m/api/push/key')])
    }).then(function (x) {
      return x[0].pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(x[1].publicKey) })
    }).then(function (sub) {
      return post('/m/api/push/subscribe', { subscription: sub.toJSON(), label: deviceLabel() })
    })
  }
  function pushRows(st) {
    function row(a, icon, title, sub, chev) {
      return '<button class="opt-row"' + (a ? ' data-a="' + a + '"' : ' disabled') + '><span class="ico">' + ic(icon, 's') + '</span><span class="mid"><b>' + title + '</b><small>' + sub + '</small></span>' + (chev ? ic('chev', 's') : '') + '</button>'
    }
    switch (st.state) {
      case 'install': return row('', 'alert', '锁屏提醒', '在 Safari 点“分享”→“添加到主屏幕”，从主屏幕打开后在这里开启')
      case 'unsupported': return row('', 'alert', '锁屏提醒', '这个浏览器不支持网页推送')
      case 'denied': return row('', 'alert', '锁屏提醒', '通知权限被拒绝了，请在系统设置里允许 DSH 通知')
      case 'off': return row('push-on', 'alert', '开启锁屏提醒', '完成、出错、需要你确认时通知你', true)
      case 'on': return row('push-test', 'checkc', '锁屏提醒已开启', '点这里发一条测试推送') + row('push-off', 'x', '关闭锁屏提醒', '这台设备不再收到推送')
      default: return ''
    }
  }
  el.status.onclick = function () {
    openSheet('<div class="sh-h">连接<small>' + esc(location.host) + '</small></div><div class="sh-b">' +
      '<button class="opt-row" data-a="reload"><span class="ico">' + ic('refresh', 's') + '</span><span class="mid"><b>重新连接</b><small>' +
      ({ online: '当前已连接', connecting: '正在连接…', offline: '电脑暂时连不上' })[S.status] + '</small></span></button>' +
      (IN_APP ? '<button class="opt-row" data-a="server"><span class="ico">' + ic('web', 's') + '</span><span class="mid"><b>切换服务器</b><small>换一台电脑，或换一个访问地址</small></span>' + ic('chev', 's') + '</button>' : '') +
      '<button class="opt-row" data-a="usage"><span class="ico">' + ic('stats', 's') + '</span><span class="mid"><b>最近 7 天用量</b><small>token、缓存命中，用得最多的会话</small></span>' + ic('chev', 's') + '</button>' +
      '<div id="pushRows"></div></div>')
    var cur = { state: 'app' }
    function paintPush() {
      pushState().then(function (st) {
        cur = st
        var box = document.getElementById('pushRows')
        if (box) box.innerHTML = pushRows(st)
      })
    }
    paintPush()
    el.sheet.onclick = function (e) {
      var b = e.target.closest('[data-a]')
      if (!b || b.disabled) return
      var a = b.dataset.a
      if (a === 'server') { location.href = 'dshapp://setup'; return }
      if (a === 'usage') { closeOverlay().then(weekSheet); return }
      if (a === 'push-on') {
        b.disabled = true
        enablePush().then(function () { toast('已开启锁屏提醒'); buzz(); paintPush() }, function (err) { b.disabled = false; toast(err.message, 'err') })
        return
      }
      if (a === 'push-test' && cur.sub) {
        post('/m/api/push/test', { endpoint: cur.sub.endpoint }).then(function (v) {
          toast(v.status >= 200 && v.status < 300 ? '已发出，几秒内锁屏应该收到' : '推送服务返回 ' + v.status, v.status >= 300 ? 'err' : '')
        }, function (err) { toast(err.message, 'err') })
        return
      }
      if (a === 'push-off' && cur.sub) {
        var sub = cur.sub
        post('/m/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(function () {}).then(function () { return sub.unsubscribe() }).then(function () { toast('已关闭锁屏提醒'); paintPush() }, function (err) { toast(err.message, 'err') })
        return
      }
      closeOverlay().then(function () { connect(); loadBoot().catch(function (err) { toast(err.message, 'err') }) })
    }
  }
  document.getElementById('btnSearch').onclick = function () { el.searchBox.hidden = false; el.q.focus() }
  document.getElementById('qClose').onclick = function () { el.q.value = ''; S.query = ''; el.searchBox.hidden = true; renderHome() }
  el.q.oninput = function () { S.query = el.q.value.trim(); renderHome() }
  el.fab.onclick = newSheet
  document.getElementById('back').onclick = function () { history.back() }
  el.head.onclick = modelSheet
  document.getElementById('more').onclick = moreSheet
  el.sheetWrap.firstElementChild.onclick = function () { closeOverlay() }
  el.viewer.onclick = function () { closeOverlay() }
  document.getElementById('fvBack').onclick = function () { history.back() }
  el.fvBody.addEventListener('click', function (e) {
    var en = fv[fv.length - 1], b
    if (!en) return
    if ((b = e.target.closest('a[href]'))) { e.preventDefault(); window.open(b.href, '_blank', 'noopener'); return }
    if ((b = e.target.closest('[data-fe]'))) {
      fvOpen({ kind: 'path', s: en.s, path: (en.data.rel ? en.data.rel + '/' : '') + b.dataset.fe, title: b.dataset.fe })
      return
    }
    if ((b = e.target.closest('[data-fp]'))) { if (b.dataset.fp) fvOpen({ kind: 'path', s: en.s, path: b.dataset.fp, title: baseName(b.dataset.fp) }); return }
    if ((b = e.target.closest('[data-fdir]'))) { fvOpen({ kind: 'path', s: en.s, path: b.dataset.fdir, title: baseName(b.dataset.fdir) || '工作区' }); return }
    if ((b = e.target.closest('[data-mdv]'))) { en.src = b.dataset.mdv === '1'; fvPaint(en); return }
    if ((b = e.target.closest('[data-copy]'))) { copy(b.closest('pre').querySelector('code').textContent); return }
    if ((b = e.target.closest('.fvimg'))) view(b.src)
  })

  // pull to refresh (home list)
  ;(function () {
    var y0 = null, dy = 0, busy = false
    el.list.addEventListener('touchstart', function (e) { y0 = el.list.scrollTop <= 0 && !busy ? e.touches[0].clientY : null; dy = 0 }, { passive: true })
    el.list.addEventListener('touchmove', function (e) {
      if (y0 == null) return
      dy = Math.max(0, e.touches[0].clientY - y0)
      el.ptr.style.height = Math.min(72, dy * 0.45) + 'px'
      el.ptr.firstElementChild.style.transform = 'rotate(' + dy * 1.6 + 'deg)'
    }, { passive: true })
    el.list.addEventListener('touchend', function () {
      if (y0 == null) return
      y0 = null
      function done() { busy = false; el.ptr.classList.remove('go'); el.ptr.style.transition = 'height .25s'; el.ptr.style.height = '0'; setTimeout(function () { el.ptr.style.transition = '' }, 260) }
      if (dy * 0.45 >= 56) {
        busy = true
        el.ptr.classList.add('go')
        el.ptr.style.height = '48px'
        buzz()
        if (!es) connect()
        loadBoot().then(done, function (e) { toast(e.message, 'err'); done() })
      } else done()
    })
  })()

  el.scroller.addEventListener('click', function (e) {
    var c = S.chats.get(S.cur), b
    if (!c) return
    if ((b = e.target.closest('a[href]'))) { e.preventDefault(); window.open(b.href, '_blank', 'noopener'); return }
    if ((b = e.target.closest('[data-full]'))) {
      for (var n = c.items.length - 1; n >= 0; n--) {
        var ft = c.items[n]
        if (ft.k === 't' && ft.id === b.dataset.full) { fvOpen({ kind: 'call', s: c.id, id: ft.id, seq: ft.seq, rseq: ft.rseq, title: ft.title }); break }
      }
      return
    }
    if ((b = e.target.closest('[data-fp]'))) { fvOpen({ kind: 'path', s: c.id, path: b.dataset.fp, title: baseName(b.dataset.fp) }); return }
    if ((b = e.target.closest('[data-group]'))) { var k = +b.dataset.group; if (c.open.has(k)) c.open.delete(k); else c.open.add(k); renderMsgs(c, false, true); return }
    if ((b = e.target.closest('[data-tool]'))) {
      for (var i = c.items.length - 1; i >= 0; i--) if (c.items[i].k === 't' && c.items[i].id === b.dataset.tool) { c.items[i]._o = !c.items[i]._o; break }
      renderMsgs(c, false, true)
      return
    }
    if ((b = e.target.closest('[data-think]'))) { c.items.forEach(function (it) { if (it.seq === +b.dataset.think) it._t = !it._t }); renderMsgs(c, false, true); return }
    if ((b = e.target.closest('[data-copy]'))) { copy(b.closest('pre').querySelector('code').textContent); return }
    if ((b = e.target.closest('[data-copymsg]'))) { c.items.forEach(function (it) { if (it.seq === +b.dataset.copymsg) copy(it.text) }); return }
    if ((b = e.target.closest('[data-older]'))) { loadOlder(c); return }
    if ((b = e.target.closest('[data-retry]'))) { loadHistory(c); return }
    if ((b = e.target.closest('img[data-view]'))) { view(b.src); return }
  })
  el.scroller.addEventListener('scroll', function () { el.toBottom.hidden = nearBottom() }, { passive: true })
  el.toBottom.onclick = function () { el.scroller.scrollTo({ top: el.scroller.scrollHeight, behavior: 'smooth' }) }
  window.addEventListener('resize', function () { if (S.cur && nearBottom()) toBottom() })

  el.dock.addEventListener('click', function (e) {
    var c = S.chats.get(S.cur), b
    if (!c) return
    if ((b = e.target.closest('[data-allow],[data-deny],[data-remember]'))) {
      var id = b.dataset.allow || b.dataset.deny || b.dataset.remember, a = S.asks.get(id)
      if (!a) return
      var outcome = b.dataset.deny ? 'rejected' : 'allowed-once'
      b.parentNode.querySelectorAll('button').forEach(function (x) { x.disabled = true })
      buzz(outcome === 'allowed-once' ? 15 : 8)
      var value = { sessionId: a.s, approvalId: a.id, outcome: outcome }
      if (b.dataset.remember) value.remember = true
      respond(a.rpc, { ok: true, value: value }).then(function (r) {
        S.asks.delete(id)
        drawDock(); scheduleHome()
        if (!r.accepted && r.reason !== 'not-pending') toast('没有生效：' + r.reason, 'err')
      }, function (err) { drawDock(); toast(err.message, 'err') })
      return
    }
    var card = e.target.closest('[data-q]')
    if (card) {
      var q = S.qs.get(card.dataset.q)
      if (!q) return
      if ((b = e.target.closest('[data-qo]'))) {
        var ix = b.dataset.qo.split(':'), item = q.qs[+ix[0]], opt = item.options[+ix[1]], cur = q._sel[item.id] || []
        if (item.multiSelect) q._sel[item.id] = cur.indexOf(opt.label) >= 0 ? cur.filter(function (x) { return x !== opt.label }) : cur.concat(opt.label)
        else q._sel[item.id] = [opt.label]
        buzz(6)
        drawDock()
        return
      }
      if (e.target.closest('[data-qcancel]')) {
        respond(q.rpc, { ok: false, error: { code: 'cancelled', message: 'the user closed this question request', details: {} } }).then(function () { S.qs.delete(q.rpc); drawDock(); scheduleHome() }, function (err) { toast(err.message, 'err') })
        return
      }
      if (e.target.closest('[data-qsubmit]')) {
        var missing = false
        var answers = q.qs.map(function (it) {
          var selected = q._sel[it.id] || [], custom = (q._custom[it.id] || '').trim()
          if (!selected.length && !custom) missing = true
          var ans = { id: it.id, selected: selected }
          if (custom) ans.custom = custom
          return ans
        })
        if (missing) { toast('每个问题都需要回答'); return }
        respond(q.rpc, { ok: true, value: { sessionId: q.s, answer: { answers: answers } } }).then(function () { S.qs.delete(q.rpc); drawDock(); scheduleHome(); buzz() }, function (err) { toast(err.message, 'err') })
        return
      }
      return
    }
    if ((b = e.target.closest('[data-unqueue]'))) {
      rpc('session.updateQueue', { sessionId: c.id, itemId: b.dataset.unqueue, action: { kind: 'remove' } }).then(function () {}, function (err) { toast(err.message, 'err') })
      return
    }
    if (e.target.closest('[data-todo]')) { c.todoOpen = !c.todoOpen; drawDock() }
  })
  el.dock.addEventListener('input', function (e) {
    var inp = e.target.closest('[data-qi]'), card = e.target.closest('[data-q]')
    if (!inp || !card) return
    var q = S.qs.get(card.dataset.q)
    if (q) q._custom[q.qs[+inp.dataset.qi].id] = inp.value
  })
  el.dock.addEventListener('focusout', function () { setTimeout(function () { if (dockDirty && !el.dock.contains(document.activeElement)) drawDock() }, 0) })

  el.input.addEventListener('input', function () { autosize(); syncSend() })
  el.send.onclick = function () { if (el.send.classList.contains('stop')) stop(); else send() }
  el.attach.onclick = function () { el.file.click() }
  el.quick.onclick = quickSheet
  el.file.onchange = function () {
    var files = Array.prototype.slice.call(el.file.files || [], 0, Math.max(0, 6 - S.att.length))
    el.file.value = ''
    Promise.all(files.map(function (f) { return prepImage(f).catch(function () { toast('有图片读取失败', 'err'); return null }) })).then(function (list) {
      list.forEach(function (a) { if (a) S.att.push(a) })
      drawThumbs(); syncSend()
    })
  }
  el.thumbs.addEventListener('click', function (e) {
    var b = e.target.closest('[data-rm]')
    if (!b) return
    S.att.splice(+b.dataset.rm, 1)
    drawThumbs(); syncSend()
  })

  setInterval(function () { if (!S.cur && document.visibilityState === 'visible') scheduleHome() }, 60000)

  // ------------------------------------------------------------ Android shell hooks
  // In-app update: the shell reports "DSHApp/<version>+<code>" (1.3.0+); older shells
  // cannot update themselves and only get a hint.
  var APP_CODE = +((/DSHApp\/[\d.]+\+(\d+)/.exec(navigator.userAgent) || [])[1] || 0)
  function checkAppUpdate() {
    if (!IN_APP) return
    get('/m/api/app/latest').then(function (v) {
      if (APP_CODE ? v.versionCode > APP_CODE : true) { S.appUpdate = { versionName: v.versionName, self: APP_CODE > 0 }; scheduleHome() }
    }, function () {})
  }
  window.dshToast = function (msg, kind) { toast(msg, kind) }

  // "Share to DSH" from another app: pick the conversation, then review in the composer.
  function b64Blob(b64, type) {
    var bin = atob(b64), a = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i)
    return new Blob([a], { type: type })
  }
  function fillShare(id, share) {
    el.input.value = share.text
    S.att = isAgent(id) ? [] : share.imgs.slice(0, 6)
    drawThumbs(); autosize(); syncSend()
    if (isAgent(id) && share.imgs.length) toast('Claude Code / Codex 会话只能发文字，图片没带上')
    setTimeout(function () { el.input.focus() }, 380)
  }
  window.dshShare = function (p) {
    if (!p) return
    var share = {
      text: [p.subject, p.text].filter(Boolean).join('\n').trim(),
      imgs: (p.images || []).slice(0, 6).map(function (im) { return { url: URL.createObjectURL(b64Blob(im.b64, im.type || 'image/jpeg')), b64: im.b64, type: im.type || 'image/jpeg', name: im.name || 'shared.jpg' } }),
    }
    var dsh = S.sessions.slice().sort(function (a, b) { return b.at - a.at }).slice(0, 6)
    var ags = S.agents.sessions.slice(0, 3)
    var what = (share.imgs.length ? share.imgs.length + ' 张图片' : '') + (share.text ? (share.imgs.length ? ' · ' : '') + share.text.slice(0, 40) : '')
    closeAllOverlays().then(function () {
      openSheet('<div class="sh-h">分享到 DSH<small>' + esc(what || '内容') + '</small></div><div class="sh-b">' +
        '<button class="opt-row" data-new><span class="ico">' + ic('plus', 's') + '</span><span class="mid"><b>新对话</b><small>选一个工作区</small></span>' + ic('chev', 's') + '</button>' +
        dsh.map(function (s) { return '<button class="opt-row" data-sid="' + esc(s.id) + '"><span class="ico">' + ic('folder', 's') + '</span><span class="mid"><b>' + esc(s.title || '未命名对话') + '</b><small>' + esc(wsTitle(s.w)) + '</small></span></button>' }).join('') +
        ags.map(function (a) { return '<button class="opt-row" data-sid="' + esc(a.id) + '"><span class="ico">' + ic('execute', 's') + '</span><span class="mid"><b>' + esc(a.title || a.project || a.name) + '</b><small>' + esc(a.name + (a.project ? ' · ' + a.project : '')) + '</small></span></button>' }).join('') +
        '</div>')
      el.sheet.onclick = function (e) {
        var b = e.target.closest('[data-sid],[data-new]')
        if (!b) return
        closeOverlay().then(function () {
          if (b.dataset.sid) { openChat(b.dataset.sid); fillShare(b.dataset.sid, share) }
          else { S.share = share; newSheet() }
        })
      }
    })
  }

  // ------------------------------------------------------------ boot
  // The Android shell calls this when a notification is tapped.
  window.dshOpen = function (id) {
    if (!id) return
    if (overlays.length) closeAllOverlays().then(function () { openChat(id) })
    else if (S.cur !== id) openChat(id)
  }
  // /m/?debug exposes the frame entry point for UI checks with synthetic frames.
  if (/[?&]debug\b/.test(location.search)) window.__dsh = { S: S, onFrame: onFrame }
  var deep = decodeURIComponent((location.hash || '').slice(1))
  history.replaceState({ v: 'home' }, '', location.pathname)
  var cached = store.get('boot', null)
  if (cached && cached.sessions) { try { applyBoot(cached); S.run = new Set() } catch (e) {} }
  renderHome()
  loadBoot().then(function () { if (deep && (S.byId[deep] || isAgent(deep))) openChat(deep) }, function (e) { toast(e.message, 'err') })
  checkAppUpdate()
  connect()
})()
