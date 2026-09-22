#!/usr/bin/env node
/**
 * README screenshots from the demo (plugin/dev.mjs --demo) in a phone-sized
 * headless Chrome or Edge. Starts its own demo server and browser, clicks
 * through the UI the way a person would, and writes docs/img/*.png.
 * Everything shown is made-up demo data.
 *
 *   node tools/screenshots.mjs            (BROWSER=/path/to/chrome to choose the browser)
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'docs', 'img')
const PORT = Number(process.env.PORT || 3097)
const CDP = Number(process.env.CDP_PORT || 9556)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const bin = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((b) => b && fs.existsSync(b))
if (!bin) { console.error('No Chrome or Edge found; set BROWSER=/path/to/chrome'); process.exit(1) }

async function until(fn, ms = 20000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await sleep(250)
  }
}

const children = []
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-shots-'))
function cleanup() {
  for (const c of children) { try { c.kill() } catch {} }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} }, 1500)
}
process.on('exit', cleanup)

// 1. The demo: made-up projects and sessions behind the real plugin.
const dev = spawn(process.execPath, [path.join(ROOT, 'plugin', 'dev.mjs'), '--demo'], {
  env: { ...process.env, PORT: String(PORT), DEMO_ROOT: path.join(os.tmpdir(), 'dsh-pager-shots') },
  stdio: ['ignore', 'ignore', 'inherit'],
})
children.push(dev)
await until(() => fetch(`http://127.0.0.1:${PORT}/m/api/ping`).then((r) => r.ok))
await sleep(4500) // the demo's Claude Code approval arrives after the plugin writes hook.json

// 2. A phone-sized browser.
const browser = spawn(bin, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--lang=zh-CN', 'about:blank'], { stdio: 'ignore' })
children.push(browser)
const target = await until(async () => (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((t) => t.type === 'page'))
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let seq = 0
const waiting = new Map()
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id) } }
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  waiting.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)))
  ws.send(JSON.stringify({ id, method, params }))
})
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36' })

// Click the first visible element matching `sel` whose text contains `text`.
const click = (sel, text = '') => js(`(async () => {
  for (let i = 0; i < 40; i++) {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.offsetParent !== null && e.textContent.includes(${JSON.stringify(text)}))
    if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return true }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('not found: ' + ${JSON.stringify(sel + ' ' + text)})
})()`)

async function shot(name, dark = false) {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
  await sleep(700)
  // Keep only a settled frame: a capture taken while an overlay slides in can come out torn.
  let data = (await send('Page.captureScreenshot', { format: 'png' })).data
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    const again = (await send('Page.captureScreenshot', { format: 'png' })).data
    if (again === data) break
    data = again
  }
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, name + '.png')
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`${path.relative(ROOT, file)}  ${Math.round(fs.statSync(file).size / 1024)} KB`)
}
const home = async () => { await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/m/` }); await sleep(2500) }

// 3. The screens.
await home()
await shot('home')

await click('.row, [data-s], button, a', '首页首屏慢')
await sleep(1800)
await shot('chat')

// The edit rows sit in a group of tool calls: open it, open the ProductCard edit, then its full diff.
await click('[data-group]', 'Lighthouse')
await sleep(400)
await click('[data-tool]', 'ProductCard')
await sleep(400)
await click('[data-full]', '完整内容')
await sleep(1800)
await shot('diff')

await home()
await click('.row, [data-s], button, a', '订单列表导出 CSV')
await sleep(1800)
await shot('approval')

await home()
await click('.row, [data-s], button, a', '购物车迁到 Pinia')
await sleep(1800)
await shot('agents')

await home()
await shot('home-dark', true)

ws.close()
process.exit(0)
