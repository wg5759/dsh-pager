import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeHooks, hookCommand } from './install-hooks.mjs'

const theirs = { SessionStart: [{ hooks: [{ type: 'command', command: 'node C:/kb/loader.mjs' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }] }

test('install keeps other hooks and adds ours once per event', () => {
  const cmd = hookCommand('claude', { node: 'C:\\node\\node.exe', hook: 'E:\\x\\pager-hook.mjs' })
  assert.equal(cmd, '"C:/node/node.exe" "E:/x/pager-hook.mjs" claude')
  const once = mergeHooks(theirs, 'claude', { command: cmd })
  const twice = mergeHooks(once, 'claude', { command: cmd })
  assert.deepEqual(twice, once) // idempotent
  assert.equal(once.SessionStart.length, 2)
  assert.deepEqual(once.SessionStart[0], theirs.SessionStart[0])
  assert.deepEqual(once.PreToolUse, theirs.PreToolUse)
  assert.deepEqual(once.PermissionRequest, [{ hooks: [{ type: 'command', command: cmd, timeout: 1800 }] }])
  assert.equal(once.Notification[0].matcher, 'permission_prompt')
})

test('codex gets its own event set; uninstall restores the original', () => {
  const cmd = hookCommand('codex', { node: 'n', hook: 'h/pager-hook.mjs' })
  const c = mergeHooks({}, 'codex', { command: cmd })
  assert.deepEqual(Object.keys(c).sort(), ['PermissionRequest', 'SessionStart', 'Stop', 'UserPromptSubmit'])
  assert.deepEqual(mergeHooks(mergeHooks(theirs, 'claude'), 'claude', { remove: true }), theirs)
  assert.deepEqual(mergeHooks(undefined, 'codex', { remove: true }), {})
})
