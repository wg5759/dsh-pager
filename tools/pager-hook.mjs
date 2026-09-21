#!/usr/bin/env node
/**
 * Hook command for Claude Code and Codex CLI: forwards the hook event to the
 * dsh-pager plugin and prints its answer (see plugin/agents.js).
 *
 *   node tools/pager-hook.mjs claude      (Claude Code settings.json hooks)
 *   node tools/pager-hook.mjs codex       (~/.codex/hooks.json)
 *
 * The plugin writes where to reach it to ~/.dsh-pager/hook.json
 * ({url, token}). Fail-open by design: no config, DSH not running, an error or
 * a dropped connection all print nothing and exit 0, so the tool carries on
 * exactly as if this hook did not exist.
 *
 * node:http rather than fetch: a PermissionRequest answer can take many
 * minutes (the user is away, the phone decides), and fetch aborts after 5.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const src = process.argv[2]
// --home <dir>: another pager instance's config (a dev server, a second DSH profile).
const homeAt = process.argv.indexOf('--home')
const dir = (homeAt > 0 && process.argv[homeAt + 1]) || process.env.DSH_PAGER_HOME || path.join(os.homedir(), '.dsh-pager')

function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', () => resolve(''))
  })
}

function post(url, token, body, waitMs) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(url) } catch { resolve(''); return }
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) { resolve(''); return }
    const req = http.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pager-token': token, 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(res.statusCode === 200 ? Buffer.concat(chunks).toString('utf8') : ''))
      res.on('error', () => resolve(''))
    })
    req.setTimeout(waitMs, () => { req.destroy(); resolve('') })
    req.on('error', () => resolve(''))
    req.end(body)
  })
}

async function main() {
  if (src !== 'claude' && src !== 'codex') return
  let cfg
  try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'hook.json'), 'utf8')) } catch { return }
  const input = await readStdin()
  let ev
  try { ev = JSON.parse(input) } catch { return }
  // Only a permission request is worth waiting for; everything else must not slow the tool down.
  const waitMs = ev.hook_event_name === 'PermissionRequest' ? 2 * 3600 * 1000 : 3000
  const out = await post(`${cfg.url}?src=${src}`, cfg.token, input, waitMs)
  let answer
  try { answer = JSON.parse(out) } catch { return }
  if (answer && typeof answer === 'object' && Object.keys(answer).length) process.stdout.write(JSON.stringify(answer))
}

main().then(() => process.exit(0), () => process.exit(0))
