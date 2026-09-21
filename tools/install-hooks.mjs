#!/usr/bin/env node
/**
 * Register tools/pager-hook.mjs with Claude Code and/or Codex CLI, so their
 * approvals and "done" events reach the phone through the dsh-pager plugin.
 *
 *   node tools/install-hooks.mjs claude          ~/.claude/settings.json  ("hooks")
 *   node tools/install-hooks.mjs codex           ~/.codex/hooks.json
 *   node tools/install-hooks.mjs claude --uninstall
 *   node tools/install-hooks.mjs codex --dry-run  (print, write nothing)
 *
 * Merges, never replaces: other hooks stay as they are; ours are recognized
 * by the pager-hook.mjs path, so running this again updates them in place.
 * The original file is copied to <file>.bak-dsh-pager-<time> before writing.
 *
 * Codex runs a new hook only after you trust it: open Codex and use /hooks.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pager-hook.mjs')
const slash = (p) => p.replace(/\\/g, '/')

/** The hook command line: absolute node + script, so it works whatever PATH the tool runs with. */
export function hookCommand(src, { node = process.execPath, hook = HOOK } = {}) {
  return `"${slash(node)}" "${slash(hook)}" ${src}`
}

// Event -> [matcher, timeout seconds]. PermissionRequest may wait for the phone (the plugin
// hands it back to the PC after 20 minutes), everything else returns at once.
const EVENTS = {
  claude: { SessionStart: [null, 10], UserPromptSubmit: [null, 10], PermissionRequest: [null, 1800], Stop: [null, 10], SessionEnd: [null, 5], Notification: ['permission_prompt', 10] },
  codex: { SessionStart: [null, 10], UserPromptSubmit: [null, 10], PermissionRequest: [null, 1800], Stop: [null, 10] },
}

const ours = (h) => h && typeof h.command === 'string' && h.command.includes('pager-hook.mjs')

/**
 * Merge (or with `remove`, strip) our entries into a `hooks` object of the
 * Claude Code / Codex shape: { Event: [ { matcher?, hooks: [ {type, command, timeout} ] } ] }.
 */
export function mergeHooks(hooks, src, { remove = false, command = hookCommand(src) } = {}) {
  const out = {}
  for (const [event, groups] of Object.entries(hooks || {})) {
    const kept = (Array.isArray(groups) ? groups : [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) }))
      .filter((g) => g.hooks.length)
    if (kept.length) out[event] = kept
  }
  if (remove) return out
  for (const [event, [matcher, timeout]] of Object.entries(EVENTS[src])) {
    const group = { hooks: [{ type: 'command', command, timeout }] }
    if (matcher) group.matcher = matcher
    out[event] = [...(out[event] || []), group]
  }
  return out
}

function target(src) {
  if (src === 'claude') return path.join(os.homedir(), '.claude', 'settings.json')
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json')
}

function main(argv) {
  const src = argv[0]
  if (!EVENTS[src]) {
    console.error('usage: node tools/install-hooks.mjs <claude|codex> [--uninstall] [--dry-run]')
    return 2
  }
  const remove = argv.includes('--uninstall')
  const dry = argv.includes('--dry-run')
  const file = target(src)
  let doc = {}
  if (fs.existsSync(file)) {
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
      console.error(`cannot parse ${file}: ${e.message} (left untouched)`)
      return 1
    }
  }
  const next = { ...doc, hooks: mergeHooks(doc.hooks, src, { remove }) }
  if (src === 'codex' && !next.description) next.description = 'dsh-pager: phone approvals and notifications'
  if (!Object.keys(next.hooks).length) delete next.hooks
  const text = JSON.stringify(next, null, 2) + '\n'
  if (dry) { console.log(text); return 0 }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
    fs.copyFileSync(file, `${file}.bak-dsh-pager-${stamp}`)
  }
  fs.writeFileSync(file, text)
  console.log(`${remove ? 'removed from' : 'installed into'} ${file}`)
  if (src === 'codex' && !remove) console.log('Codex runs new hooks only after you trust them: open Codex and use /hooks.')
  return 0
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)))
