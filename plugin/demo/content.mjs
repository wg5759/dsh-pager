/**
 * Made-up content for the demo: two small projects, their sessions as DSH
 * events, a waiting approval and question, the replies a demo turn streams,
 * and Claude Code / Codex session files. Nothing here comes from a real
 * machine; the project files are written under the demo root so the result
 * viewer has something to open.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIN = 60 * 1000

// ---- project files (the "after" state of the edits below) -----------------

const CARD_BEFORE = `<template>
  <a class="card" :href="'/p/' + p.id">
    <img :src="p.cover" :alt="p.name">
    <h3>{{ p.name }}</h3>
    <p class="price">¥{{ p.price }}</p>
  </a>
</template>

<script setup>
defineProps({ p: Object })
</script>
`
const CARD_AFTER = `<template>
  <a class="card" :href="'/p/' + p.id">
    <img :src="p.cover" :alt="p.name" width="320" height="320"
         :loading="eager ? 'eager' : 'lazy'" decoding="async">
    <h3>{{ p.name }}</h3>
    <p class="price">¥{{ p.price }}</p>
  </a>
</template>

<script setup>
defineProps({ p: Object, eager: Boolean })
</script>
`
const HOME_BEFORE = `<template>
  <Banner />
  <section class="grid">
    <ProductCard v-for="p in products" :key="p.id" :p="p" />
  </section>
</template>
`
const HOME_AFTER = `<template>
  <Banner />
  <section class="grid">
    <!-- 首屏前 4 张立即加载，其余滚动到附近再加载 -->
    <ProductCard v-for="(p, i) in products" :key="p.id" :p="p" :eager="i < 4" />
  </section>
</template>
`
const CSV = `// 导出为 CSV：带 UTF-8 BOM，Excel 打开中文不乱码
export function toCsv(rows, columns) {
  const cell = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const head = columns.map((c) => cell(c.label)).join(',')
  const body = rows.map((r) => columns.map((c) => cell(r[c.key])).join(','))
  return '\\uFEFF' + [head, ...body].join('\\r\\n')
}
`
const ORDERS_BEFORE = `<template>
  <OrderFilters v-model="filters" />
  <OrderTable :rows="rows" />
</template>

<script setup>
import { useOrderFilters } from '../composables/orders'
const { filters, rows } = useOrderFilters()
</script>
`
const ORDERS_AFTER = `<template>
  <OrderFilters v-model="filters">
    <button class="btn" @click="exportCsv">导出 CSV</button>
  </OrderFilters>
  <OrderTable :rows="rows" />
</template>

<script setup>
import { useOrderFilters } from '../composables/orders'
import { toCsv } from '../utils/csv'
const { filters, rows } = useOrderFilters()

const columns = [
  { key: 'no', label: '订单号' }, { key: 'buyer', label: '买家' },
  { key: 'total', label: '金额' }, { key: 'status', label: '状态' },
]
function exportCsv() {
  const blob = new Blob([toCsv(rows.value, columns)], { type: 'text/csv' })
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'orders.csv' })
  a.click()
}
</script>
`
const FEED_BEFORE = `export function item(post) {
  return {
    title: post.title,
    link: SITE + post.slug,
    pubDate: new Date(post.date).toUTCString(),
  }
}
`
const FEED_AFTER = `export function item(post) {
  return {
    title: post.title,
    link: SITE + post.slug,
    // 文章日期只写了年月日：按北京时间解析，不能当成 UTC 零点
    pubDate: new Date(post.date + 'T00:00:00+08:00').toUTCString(),
  }
}
`

const FILES = {
  'shop-web/README.md': `# shop-web

小店的网页前端（Vue 3 + Vite）。

## 开发

\`\`\`bash
npm install
npm run dev      # http://localhost:5173
npm test         # 单元测试
npm run test:e2e # 端到端测试（Playwright）
\`\`\`

## 最近的改动

- 首页商品图懒加载，首屏 LCP 4.2 s → 1.6 s
- 订单列表可以导出 CSV（按当前筛选）
`,
  'shop-web/package.json': JSON.stringify({ name: 'shop-web', private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build', test: 'vitest run', 'test:e2e': 'playwright test' } }, null, 2) + '\n',
  'shop-web/src/components/ProductCard.vue': CARD_AFTER,
  'shop-web/src/pages/Home.vue': HOME_AFTER,
  'shop-web/src/pages/Orders.vue': ORDERS_AFTER,
  'shop-web/src/utils/csv.js': CSV,
  'shop-web/.env': 'PAYMENT_KEY=demo-only-not-a-real-key\n',
  'blog/CHANGELOG.md': `# Changelog

## v2.3

- 暗色主题（跟随系统）
- RSS 日期按北京时间输出
- 评论区改为滚动到附近再加载，文章页打开快了 40%
- 代码块支持一键复制
- 修复：标签页分页在最后一页显示空白
`,
  'blog/src/feed.js': FEED_AFTER,
  'blog/posts/2026-09-10-hello-dark-mode.md': '# 你好，暗色主题\n\n博客现在会跟随系统切换暗色主题。\n',
}

/** Write the demo projects under `root`; returns their paths. */
export function writeProjects(root) {
  for (const [rel, text] of Object.entries(FILES)) {
    const f = path.join(root, rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, text)
  }
  const logo = path.join(root, 'shop-web', 'public', 'logo.png')
  fs.mkdirSync(path.dirname(logo), { recursive: true })
  fs.copyFileSync(path.join(HERE, '..', 'www', 'icon-512.png'), logo)
  return { shop: path.join(root, 'shop-web'), blog: path.join(root, 'blog') }
}

// ---- DSH sessions ------------------------------------------------------------

/**
 * Appends DSH events with increasing seq/time; views as the host presenter makes them.
 * Scripted history steps the clock by `dt`; a live turn passes `clock` (real time) and
 * `onPush`, which may renumber the event before it is broadcast.
 */
export function book(startTime, { clock, onPush } = {}) {
  let seq = 0
  let time = startTime
  const ev = []
  const push = (type, data, view, dt = 1500) => {
    time = clock ? clock() : time + dt
    const e = { event: { type, seq: ++seq, time, data } }
    if (view) e.view = view
    ev.push(e)
    if (onPush) onPush(e)
    return e
  }
  return {
    ev,
    next: () => seq + 1,
    user: (text, dt, rpcId) => push('user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', ...(rpcId ? { rpcId } : {}) } }, null, dt),
    turn: (dt) => push('turn/start', {}, null, dt),
    step: (dt) => push('step/start', {}, null, dt),
    say: (text, think, dt) => push('assistant/message', { message: { role: 'assistant', content: [...(think ? [{ type: 'reasoning', text: think }] : []), ...(text ? [{ type: 'text', text }] : [])] } }, null, dt),
    chunk: (chunk, dt = 60) => push('assistant/chunk', { chunk }, null, dt),
    call: (id, name, args, view, dt) => push('tool/call', { callId: id, name, arguments: JSON.stringify(args) }, view && { for: 'call', view }, dt),
    result: (id, text, view, isError, dt) => push('tool/result', { message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text }], isError: Boolean(isError) }] } }, view && { for: 'result', view }, dt),
    end: (kind = 'completed', dt) => push('turn/end', { reason: { kind } }, null, dt),
    title: (title) => push('session/title', { title }, null, 10),
    todos: (todos) => push('todo/write', { todos }, null, 10),
  }
}

const term = (command, description) => ({ card: 'terminal', title: command, description })
const out = (output, exitCode = 0) => ({ card: 'terminal', output, exitCode })
const diff = (title, diffs) => ({ card: 'diff', title, diffs })

export const E2E_OK = `Running 6 tests using 2 workers

  ✓ orders › 导出按钮在筛选栏里 (0.9s)
  ✓ orders › 按当前筛选导出 (2.6s)
  ✓ orders › 金额和中文不乱码 (1.8s)
  ✓ orders › 空结果也能导出表头 (0.7s)
  ✓ home › 首屏图片立即加载 (1.1s)
  ✓ home › 其余图片懒加载 (1.4s)

  6 passed (14.3s)`

/**
 * The demo's DSH sessions. Each: { id, w, title, at, running, events, approval?, question? }.
 * `now` anchors the timestamps so the list reads "刚刚 / 25 分钟前 / 昨天".
 */
export function sessions(now) {
  const list = []

  // 1. Finished: slow home page -> lazy images.
  {
    const b = book(now - 28 * MIN)
    b.user('首页首屏要 4 秒多，帮我查查原因，能改就直接改掉。', 0)
    b.turn(200)
    b.say('我先看看首页一次加载了哪些资源。', '首屏慢，先看图片和构建产物，再决定改哪里。')
    b.call('c1', 'grep', { pattern: '<img', path: 'src' }, { kind: 'search', title: '搜索 <img' })
    b.result('c1', '', { card: 'search', total: 3, files: [{ path: 'src/components/ProductCard.vue', matches: [{ lineNumber: 3, line: '<img :src="p.cover" :alt="p.name">' }] }, { path: 'src/components/Banner.vue', matches: [{ lineNumber: 2, line: '<img src="/banner.jpg" alt="">' }, { lineNumber: 9, line: '<img :src="slide.src">' }] }] })
    b.call('c2', 'read', { path: 'src/pages/Home.vue' }, { kind: 'read', title: '读取 src/pages/Home.vue' })
    b.result('c2', HOME_BEFORE, { card: 'read', path: 'src/pages/Home.vue', totalLines: 7 })
    b.say('首屏一次加载了 24 张商品大图（每张 300–600 KB），都没有懒加载，也没写尺寸。我改成首屏只立即加载前 4 张，其余滚动到附近再加载；同时补上宽高，避免布局跳动。')
    b.call('c3', 'edit', { path: 'src/components/ProductCard.vue' }, diff('编辑 ProductCard.vue', [{ path: 'src/components/ProductCard.vue', oldText: CARD_BEFORE, newText: CARD_AFTER }]))
    b.result('c3', '已修改 1 处')
    b.call('c4', 'edit', { path: 'src/pages/Home.vue' }, diff('编辑 Home.vue', [{ path: 'src/pages/Home.vue', oldText: HOME_BEFORE, newText: HOME_AFTER }]))
    b.result('c4', '已修改 1 处')
    b.call('c5', 'pwsh', { command: 'npm run build', description: '构建生产包' }, term('npm run build', '构建生产包'))
    b.result('c5', '', out('vite v6.3.5 building for production...\n✓ 412 modules transformed.\ndist/index.html                  0.62 kB │ gzip:  0.38 kB\ndist/assets/index-4f1c2a.css    18.40 kB │ gzip:  4.91 kB\ndist/assets/index-9b7e0d.js    142.77 kB │ gzip: 51.02 kB\n✓ built in 3.21s'), false, 9000)
    b.call('c6', 'pwsh', { command: 'npx lighthouse http://localhost:4173 --only-categories=performance --quiet', description: '跑一次 Lighthouse 性能测试' }, term('npx lighthouse http://localhost:4173 --only-categories=performance --quiet', '跑一次 Lighthouse 性能测试'))
    b.result('c6', '', out('Performance: 94\nFirst Contentful Paint: 0.9 s\nLargest Contentful Paint: 1.6 s\nTotal Blocking Time: 30 ms\nCumulative Layout Shift: 0.01'), false, 21000)
    b.say('改好了，首屏最大内容绘制（LCP）从 **4.2 秒降到 1.6 秒**：\n\n- 首屏只立即加载前 4 张商品图，其余滚动到附近再加载；\n- 图片补上了宽高，布局不再跳动（CLS 0.21 → 0.01）；\n- 构建产物体积没有变化。\n\n改动只在 `ProductCard.vue` 和 `Home.vue` 两个文件。要不要顺手把商品图转成 WebP？')
    b.end('completed', 800)
    list.push({ id: 'session-5b0c1e7a-demo-4a1f-9c55-1d2e3f4a5b01', w: 'w-shop', title: '首页首屏慢：图片懒加载', ev: b })
  }

  // 2. Running, waiting for an approval: export orders as CSV.
  {
    const b = book(now - 9 * MIN)
    b.user('订单列表页加一个「导出 CSV」按钮，导出当前筛选结果。', 0)
    b.turn(200)
    b.todos([{ content: '找到订单筛选逻辑', status: 'in_progress' }, { content: '加导出按钮和 CSV 工具函数', status: 'pending' }, { content: '跑测试', status: 'pending' }, { content: '更新 README', status: 'pending' }])
    b.say('好的，我先找到订单列表的筛选逻辑。')
    b.call('d1', 'grep', { pattern: 'useOrderFilters', path: 'src' }, { kind: 'search', title: '搜索 useOrderFilters' })
    b.result('d1', '', { card: 'search', total: 2, files: [{ path: 'src/composables/orders.js', matches: [{ lineNumber: 12, line: 'export function useOrderFilters() {' }] }, { path: 'src/pages/Orders.vue', matches: [{ lineNumber: 7, line: "import { useOrderFilters } from '../composables/orders'" }] }] })
    b.call('d2', 'write', { path: 'src/utils/csv.js' }, diff('新建 csv.js', [{ path: 'src/utils/csv.js', oldText: null, newText: CSV }]))
    b.result('d2', '已创建')
    b.call('d3', 'edit', { path: 'src/pages/Orders.vue' }, diff('编辑 Orders.vue', [{ path: 'src/pages/Orders.vue', oldText: ORDERS_BEFORE, newText: ORDERS_AFTER }]))
    b.result('d3', '已修改 2 处')
    b.todos([{ content: '找到订单筛选逻辑', status: 'completed' }, { content: '加导出按钮和 CSV 工具函数', status: 'completed' }, { content: '跑测试', status: 'in_progress' }, { content: '更新 README', status: 'pending' }])
    b.say('按钮和导出函数写好了。现在跑一下端到端测试，确认导出结果和别的页面都没问题。')
    b.call('d4', 'pwsh', { command: 'npm run test:e2e -- orders home', description: '跑订单页和首页的端到端测试' }, term('npm run test:e2e -- orders home', '跑订单页和首页的端到端测试'))
    list.push({
      id: 'session-8e21d4c3-demo-4b7a-8d10-6f5e4d3c2b02', w: 'w-shop', title: '订单列表导出 CSV', ev: b, running: true,
      approval: { approvalId: 'approval-demo-01', toolName: 'pwsh', callId: 'd4', reason: '这条命令会启动浏览器跑测试，需要你确认' },
    })
  }

  // 3. Running, waiting for an answer: release notes.
  {
    const b = book(now - 16 * MIN)
    b.user('根据 CHANGELOG 给 v2.3 写一篇发布说明，发在博客上。', 0)
    b.turn(200)
    b.say('我先读一下 CHANGELOG 里 v2.3 的条目。')
    b.call('q1', 'read', { path: 'CHANGELOG.md' }, { kind: 'read', title: '读取 CHANGELOG.md' })
    b.result('q1', '# Changelog\n\n## v2.3\n\n- 暗色主题（跟随系统）\n- RSS 日期按北京时间输出\n- 评论区改为滚动到附近再加载\n- 代码块支持一键复制\n- 修复：标签页分页在最后一页显示空白', { card: 'read', path: 'CHANGELOG.md', totalLines: 11 })
    b.say('v2.3 一共 5 条改动，重点是暗色主题和评论区提速。动笔前确认一下语气。')
    list.push({
      id: 'session-2f9a6b8d-demo-4c3e-a7b1-9e8d7c6b5a03', w: 'w-blog', title: '写 v2.3 发布说明', ev: b, running: true,
      question: [{ id: 'tone', header: '语气', question: '发布说明用什么语气？', options: [{ label: '正式一点', description: '像产品公告' }, { label: '轻松一点', description: '像写给老读者的信' }, { label: '你来定' }] }],
    })
  }

  // 4. Finished yesterday: RSS dates.
  {
    const b = book(now - 26 * 60 * MIN)
    b.user('RSS 里的文章日期都早了 8 个小时，查一下。', 0)
    b.turn(200)
    b.call('r1', 'grep', { pattern: 'pubDate', path: 'src' }, { kind: 'search', title: '搜索 pubDate' })
    b.result('r1', '', { card: 'search', total: 1, files: [{ path: 'src/feed.js', matches: [{ lineNumber: 5, line: 'pubDate: new Date(post.date).toUTCString(),' }] }] })
    b.say('原因找到了：文章日期只写了年月日（如 `2026-09-10`），JavaScript 会把它当成 **UTC 零点**解析，换成北京时间正好早 8 小时。改成按 +08:00 解析。')
    b.call('r2', 'edit', { path: 'src/feed.js' }, diff('编辑 feed.js', [{ path: 'src/feed.js', oldText: FEED_BEFORE, newText: FEED_AFTER }]))
    b.result('r2', '已修改 1 处')
    b.call('r3', 'pwsh', { command: 'npm test -- feed', description: '跑 RSS 相关测试' }, term('npm test -- feed', '跑 RSS 相关测试'))
    b.result('r3', '', out(' ✓ test/feed.test.js (4 tests) 12ms\n   ✓ 日期按北京时间输出\n   ✓ 跨年日期不回退\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)'), false, 6000)
    b.say('已修好并补了测试，RSS 里的日期现在和网页上一致。')
    b.end('completed', 700)
    list.push({ id: 'session-6c4d2a1b-demo-4d9f-b3e2-0a1b2c3d4e04', w: 'w-blog', title: 'RSS 日期早了 8 小时', ev: b })
  }

  // 5. Stopped two days ago.
  {
    const b = book(now - 50 * 60 * MIN)
    b.user('把项目升级到 Node 22，顺便看看哪些依赖要跟着升。', 0)
    b.turn(200)
    b.call('n1', 'pwsh', { command: 'npm outdated', description: '查看过期依赖' }, term('npm outdated', '查看过期依赖'))
    b.result('n1', '', out('Package      Current  Wanted  Latest\nvite           5.4.8   5.4.8   6.3.5\nvitest         2.1.2   2.1.2   3.2.4\n@vitejs/plugin-vue 5.1.4 5.1.4 6.0.1'), false, 4000)
    b.say('有 3 个依赖跨了大版本。我先升 vite……')
    b.end('cancelled', 3000)
    list.push({ id: 'session-9d8e7f6a-demo-4e5d-8c7b-6a5f4e3d2c05', w: 'w-shop', title: '升级到 Node 22', ev: b })
  }

  for (const s of list) {
    s.events = s.ev.ev
    s.at = s.events[s.events.length - 1].event.time
    delete s.ev
  }
  return list
}

// ---- what the demo says when you send something ---------------------------------

/** A turn for a message typed on the phone: streamed text, one harmless tool, a closing line. */
export function reply(text) {
  const t = String(text || '').trim()
  if (/测试|test/i.test(t)) {
    return {
      intro: '好的，我把测试整体跑一遍。',
      tool: { name: 'pwsh', args: { command: 'npm test', description: '运行全部单元测试' }, view: term('npm test', '运行全部单元测试'), out: out(' Test Files  9 passed (9)\n      Tests  48 passed (48)\n   Duration  2.84s') },
      outro: '全部通过：9 个文件、48 项测试。（演示模式：结果是预设的，没有真的运行。）',
    }
  }
  if (/webp|图片|压缩/i.test(t)) {
    return {
      intro: '好的，把商品图转成 WebP，保留原图做兜底。',
      tool: { name: 'pwsh', args: { command: 'npx sharp-cli -i public/products/*.jpg -o public/products -f webp -q 80', description: '批量转 WebP' }, view: term('npx sharp-cli -i public/products/*.jpg -o public/products -f webp -q 80', '批量转 WebP'), out: out('24 files converted · 11.8 MB → 3.1 MB (-74%)') },
      outro: '24 张图从 11.8 MB 降到 3.1 MB（-74%）。页面上用 `<picture>` 优先加载 WebP，旧浏览器仍用 JPG。（演示模式：结果是预设的。）',
    }
  }
  return {
    intro: `收到：「${t.length > 40 ? t.slice(0, 40) + '…' : t}」。我先看一下当前的改动。`,
    tool: { name: 'pwsh', args: { command: 'git status --short', description: '查看当前改动' }, view: term('git status --short', '查看当前改动'), out: out(' M src/pages/Orders.vue\n?? src/utils/csv.js') },
    outro: '这是演示模式：界面、流式回复、通知和审批都是真的，回复内容是预设的，不会修改任何文件。',
  }
}

/** Continuations of the waiting sessions, by how the phone answered. */
export const FOLLOW_UP = {
  approval: {
    'allowed-once': { out: out(E2E_OK), text: '6 项端到端测试全部通过。导出的 CSV 带 UTF-8 BOM，用 Excel 打开中文不乱码。README 里我也补了一句用法。' },
    rejected: { err: '用户拒绝了这次运行', text: '好的，不跑端到端测试了。你之后可以在电脑上运行 `npm run test:e2e -- orders home`。' },
  },
  question: (choice) => {
    const casual = choice === '轻松一点'
    const body = casual
      ? '# v2.3：晚上看博客不刺眼了\n\n这次最大的变化是暗色主题——博客会跟着你的系统一起变暗。评论区也改成滚动到附近才加载，文章页打开快了四成。\n'
      : '# 博客 v2.3 发布\n\n本次更新包含 5 项改进：新增跟随系统的暗色主题；RSS 日期改为按北京时间输出；评论区延迟加载，文章页加载时间缩短约 40%；代码块支持一键复制；修复标签页分页的显示问题。\n'
    const quote = body.trim().split('\n').filter(Boolean).map((l, i) => (i === 0 ? '> **' + l.replace(/^# /, '') + '**' : '> ' + l)).join('\n>\n')
    return { text: '写好了，放在 `posts/2026-09-22-v2-3.md`：\n\n' + quote, file: 'posts/2026-09-22-v2-3.md', body }
  },
}

// ---- Claude Code / Codex session files --------------------------------------------

const iso = (t) => new Date(t).toISOString()

/** A Claude Code transcript and a Codex rollout under `root`; returns their dirs and ids. */
export function writeAgentSessions(root, projects, now) {
  const claudeDir = path.join(root, 'agents', 'claude', 'projects')
  const codexDir = path.join(root, 'agents', 'codex', 'sessions')
  const cid = '7a1c9e2b-5d4f-4a8b-9c3e-1f2a3b4c5d6e'
  const xid = '0b9d8c7a-6e5f-4d3c-8b2a-9f8e7d6c5b4a'

  const cdir = path.join(claudeDir, 'demo-shop-web')
  fs.mkdirSync(cdir, { recursive: true })
  let t = now - 42 * MIN
  const at = (dt) => iso((t += dt))
  const cwd = projects.shop
  const c = [
    { type: 'user', cwd, sessionId: cid, timestamp: at(0), message: { role: 'user', content: '把购物车状态从 Vuex 迁到 Pinia，对组件暴露的接口保持不变。' } },
    { type: 'assistant', cwd, timestamp: at(4000), message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: '先读现有 store，列出组件用到的 getters 和 actions，再用 Pinia 写一个同名接口的 store。' }, { type: 'text', text: '先看一下现在的购物车 store 和用到它的组件。' }] } },
    { type: 'assistant', cwd, timestamp: at(1500), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: path.join(cwd, 'src', 'store', 'cart.js') } }] } },
    { type: 'user', cwd, timestamp: at(800), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'export default { namespaced: true, state: () => ({ items: [] }), getters: { count, total }, actions: { add, remove, clear } }' }] } },
    { type: 'assistant', cwd, timestamp: at(6000), message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '组件只用到 `count`、`total` 和 `add / remove / clear`。我写一个同名接口的 Pinia store，再把 6 个组件里的 `useStore()` 换掉。' }, { type: 'tool_use', id: 'tu2', name: 'Write', input: { file_path: path.join(cwd, 'src', 'stores', 'cart.js'), content: '…' } }] } },
    { type: 'user', cwd, timestamp: at(900), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'File created successfully' }] } },
    { type: 'assistant', cwd, timestamp: at(12000), message: { id: 'm3', role: 'assistant', content: [{ type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: 'npm test -- cart', description: '跑购物车相关测试' } }] } },
    { type: 'user', cwd, timestamp: at(5200), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu3', content: ' ✓ test/cart.test.js (11 tests) 18ms\n\n Test Files  1 passed (1)\n      Tests  11 passed (11)' }] } },
    { type: 'assistant', cwd, timestamp: at(3000), message: { id: 'm4', role: 'assistant', content: [{ type: 'text', text: '迁移完成，购物车的 11 项测试全部通过。组件那边的调用方式没变，旧的 Vuex 模块我先留着没删，确认没问题后可以一起清掉。' }] } },
    { type: 'custom-title', customTitle: '购物车迁到 Pinia', sessionId: cid },
  ]
  fs.writeFileSync(path.join(cdir, cid + '.jsonl'), c.map((o) => JSON.stringify(o)).join('\n') + '\n')

  const d = new Date(now)
  const xdir = path.join(codexDir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
  fs.mkdirSync(xdir, { recursive: true })
  t = now - 70 * MIN
  const x = [
    { type: 'session_meta', timestamp: at(0), payload: { id: xid, cwd: projects.blog } },
    { type: 'event_msg', timestamp: at(200), payload: { type: 'user_message', message: '文章页加一个目录（TOC）' } },
    { type: 'response_item', timestamp: at(5000), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我在文章渲染时收集 h2/h3：标题多于 3 个才显示目录，电脑上放在正文右侧，手机上折叠到标题下方。' }] } },
    { type: 'response_item', timestamp: at(9000), payload: { type: 'function_call', name: 'shell', call_id: 'x1', arguments: JSON.stringify({ command: ['npm', 'run', 'build'] }) } },
    { type: 'response_item', timestamp: at(7000), payload: { type: 'function_call_output', call_id: 'x1', output: JSON.stringify({ output: 'Built 42 pages in 2.1s', metadata: { exit_code: 0 } }) } },
    { type: 'response_item', timestamp: at(2000), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '目录加好了，构建通过。标题少于 4 个的短文不会显示目录。' }] } },
    { type: 'event_msg', timestamp: at(500), payload: { type: 'task_complete', duration_ms: 95000 } },
  ]
  const stamp = iso(now - 70 * MIN).slice(0, 19).replace(/:/g, '-')
  fs.writeFileSync(path.join(xdir, `rollout-${stamp}-${xid}.jsonl`), x.map((o) => JSON.stringify(o)).join('\n') + '\n')

  return { claudeDir, codexDir, claude: { sid: cid, cwd: projects.shop }, codex: { sid: xid, cwd: projects.blog } }
}
