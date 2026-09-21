import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { AgentHub, describeTool, resolveBins } from '../agents.js'

function rig({ idleMs = 1000, locked = false, mode, holdMs, dir } = {}) {
  const calls = { ask: [], askDone: [], emit: [] }
  const p = { idleMs, locked }
  const hub = new AgentHub({
    notify: { ask: (a) => calls.ask.push(a), askDone: (id, o) => calls.askDone.push([id, o]), emit: (e) => calls.emit.push(e) },
    presence: { get: () => (p.idleMs == null ? null : p) },
    pollMs: 10,
    dir,
  })
  if (mode) hub.settings.mode = mode
  if (holdMs) hub.settings.holdMs = holdMs
  return { hub, calls, p }
}
/** The hub unrefs its hold timers (DSH's web server keeps the process up); keep the test up while one runs. */
async function alive(p) {
  const keep = setInterval(() => {}, 1000)
  try { return await p } finally { clearInterval(keep) }
}
const perm = (extra = {}) => ({ session_id: 's1', cwd: 'E:\\work\\shop', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf dist', description: 'Clean build output' }, ...extra })
const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }

test('at the PC (auto): no hold, the tool shows its own dialog', async () => {
  const { hub, calls } = rig({ idleMs: 1000 })
  assert.deepEqual(await hub.handle('claude', perm()), {})
  assert.equal(calls.ask.length, 0)
  assert.equal(hub.get('agent:claude:s1').timeline[0].out, '在电脑上确认')
})

test('away: held, the phone allows; the notice carries what and where', async () => {
  const { hub, calls } = rig({ idleMs: 10 * 60 * 1000 })
  const answer = hub.handle('claude', perm())
  await new Promise((r) => setImmediate(r))
  const a = calls.ask[0]
  assert.deepEqual([a.s, a.title, a.what, a.detail, a.rpc.startsWith('agent:')], ['agent:claude:s1', 'Claude Code · shop', 'Clean build output', 'rm -rf dist', true])
  assert.deepEqual(hub.list()[0].asks, 1)
  assert.deepEqual(hub.decide(a.id, 'allowed-once'), { accepted: true })
  assert.deepEqual(await answer, ALLOW)
  assert.deepEqual(calls.askDone, [[a.id, 'allowed-once']])
  assert.deepEqual(hub.decide(a.id, 'rejected'), { accepted: false, reason: 'not-pending' })
})

test('deny, and "remember" turns suggestions into session rules (Claude Code)', async () => {
  const { hub, calls } = rig({ locked: true })
  const deny = hub.handle('codex', perm({ session_id: 'c1' }))
  await new Promise((r) => setImmediate(r))
  hub.decide(calls.ask[0].id, 'rejected')
  assert.equal((await deny).hookSpecificOutput.decision.behavior, 'deny')
  const sugg = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf dist' }], behavior: 'allow', destination: 'localSettings' }]
  const allow = hub.handle('claude', perm({ permission_suggestions: sugg }))
  await new Promise((r) => setImmediate(r))
  assert.equal(calls.ask[1].remember, true)
  hub.decide(calls.ask[1].id, 'allowed-once', { remember: true })
  assert.deepEqual((await allow).hookSpecificOutput.decision.updatedPermissions, [{ ...sugg[0], destination: 'session' }])
})

test('held requests go back to the PC: timeout, user returns, tool gives up', async () => {
  const t = rig({ locked: true, holdMs: 30 })
  assert.deepEqual(await alive(t.hub.handle('claude', perm())), {})
  assert.equal(t.calls.askDone[0][1], 'timeout')

  const b = rig({ idleMs: 10 * 60 * 1000 })
  const back = b.hub.handle('claude', perm())
  await new Promise((r) => setImmediate(r))
  b.p.idleMs = 800 // someone touched the mouse
  assert.deepEqual(await alive(back), {})
  assert.equal(b.calls.askDone[0][1], 'local')

  const g = rig({ locked: true })
  const ac = new AbortController()
  const gone = g.hub.handle('claude', perm(), { signal: ac.signal })
  await new Promise((r) => setImmediate(r))
  ac.abort()
  assert.deepEqual(await gone, {})
  assert.equal(g.calls.askDone[0][1], 'gone')
})

test('modes: phone always holds, pc never, unknown presence counts as at the PC', async () => {
  const ph = rig({ idleMs: 0, mode: 'phone' })
  const held = ph.hub.handle('claude', perm())
  await new Promise((r) => setImmediate(r))
  assert.equal(ph.calls.ask.length, 1)
  ph.hub.decide(ph.calls.ask[0].id, 'allowed-once')
  assert.deepEqual(await held, ALLOW)
  assert.deepEqual(await rig({ locked: true, mode: 'pc' }).hub.handle('claude', perm()), {})
  assert.deepEqual(await rig({ idleMs: null }).hub.handle('claude', perm()), {})
})

test('turns: prompt sets the title, Stop notifies only while away', async () => {
  const { hub, calls, p } = rig({ idleMs: 1000 })
  await hub.handle('claude', { session_id: 's1', cwd: 'D:\\proj\\blog', hook_event_name: 'UserPromptSubmit', prompt: '修一下首页\n细节见 issue' })
  await hub.handle('claude', { session_id: 's1', hook_event_name: 'Stop', last_assistant_message: '已修好。' })
  assert.equal(calls.emit.length, 0)
  p.idleMs = 20 * 60 * 1000
  await hub.handle('claude', { session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: '再跑一遍测试' })
  await hub.handle('claude', { session_id: 's1', hook_event_name: 'Stop', last_assistant_message: '测试 42 项全过。' })
  assert.deepEqual([calls.emit[0].t, calls.emit[0].title, calls.emit[0].preview], ['done', 'Claude Code · blog', '测试 42 项全过。'])
  const s = hub.list()[0]
  assert.deepEqual([s.title, s.project, s.run], ['修一下首页', 'blog', false])
  assert.deepEqual(hub.get('agent:claude:s1').timeline.map((i) => i.k), ['u', 'a', 'end', 'u', 'a', 'end'])
  p.locked = true
  await hub.handle('claude', { session_id: 's1', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  assert.equal(calls.emit[1].t, 'info')
})

test('junk is ignored; the mode persists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-agents-'))
  const { hub } = rig({ dir })
  assert.deepEqual(await hub.handle('vim', perm()), {})
  assert.deepEqual(await hub.handle('claude', { hook_event_name: 'Stop' }), {})
  assert.deepEqual(await hub.handle('claude', null), {})
  hub.setMode('phone')
  assert.throws(() => hub.setMode('never'), /bad mode/)
  assert.equal(rig({ dir }).hub.settings.mode, 'phone')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('describeTool: Claude Code and Codex tool shapes', () => {
  assert.deepEqual(describeTool('Bash', { command: 'npm test', description: 'Run tests' }), { what: 'Run tests', detail: 'npm test' })
  assert.deepEqual(describeTool('shell', { command: ['git', 'push'] }), { what: 'shell', detail: 'git push' })
  assert.deepEqual(describeTool('Write', { file_path: 'C:\\a\\b.md', content: 'x' }), { what: 'Write b.md', detail: 'C:\\a\\b.md' })
  assert.equal(describeTool('apply_patch', { input: '*** Begin Patch' }).detail, '*** Begin Patch')
  assert.deepEqual(describeTool('mcp__x__y', {}), { what: 'mcp__x__y', detail: '' })
})

function fakeChild() {
  const c = new EventEmitter()
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  return c
}

test('prompt from the phone: resume without a shell, busy guard, errors come back', async () => {
  const { hub, calls } = rig({ idleMs: 1000 })
  const spawned = []
  const spawnImpl = (cmd, args, opts) => { const c = fakeChild(); spawned.push({ cmd, args, opts, c }); return c }
  const bins = { claude: ['C:/n/node.exe', 'C:/g/cli.js'] }
  const target = { key: 'agent:claude:s9', src: 'claude', sid: 's9', cwd: String.raw`D:\p\x` }
  hub.prompt(target, '  再跑一次 & echo pwned | x > y ', { spawnImpl, bins })
  const sp = spawned[0]
  assert.deepEqual([sp.cmd, sp.args], ['C:/n/node.exe', ['C:/g/cli.js', '-p', '再跑一次 & echo pwned | x > y', '--resume', 's9', '--output-format', 'json']])
  assert.deepEqual([sp.opts.shell, sp.opts.cwd], [false, String.raw`D:\p\x`])
  assert.throws(() => hub.prompt(target, 'again', { spawnImpl, bins }), /正在运行/)
  // A phone-started turn sends its dialogs to the phone even while someone sits at the PC.
  const held = hub.handle('claude', { session_id: 's9', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } })
  await new Promise((r) => setImmediate(r))
  assert.equal(calls.ask.length, 1)
  hub.decide(calls.ask[0].id, 'rejected')
  await held
  sp.c.stdout.emit('data', '{"type":"result","is_error":true,"result":"Failed to authenticate. API Error: 401"}')
  sp.c.emit('exit', 1)
  const err = calls.emit.find((e) => e.t === 'err')
  assert.deepEqual([err.s, err.msg], ['agent:claude:s9', 'Failed to authenticate. API Error: 401'])
  assert.equal(hub.get('agent:claude:s9').running, false)
  hub.prompt({ ...target, src: 'codex', key: 'agent:codex:s9' }, 'hi', { spawnImpl, bins: {} })
  assert.deepEqual([spawned[1].cmd, spawned[1].args], ['codex', ['exec', 'resume', 's9', 'hi']])
  spawned[1].c.emit('exit', 0)
  assert.equal(calls.emit.filter((e) => e.t === 'err').length, 1)
  assert.throws(() => hub.prompt(target, '   ', { spawnImpl, bins }), /空/)
})

test('resolveBins: native exe first, npm shim becomes node + entry, nothing found is null', () => {
  const R = String.raw
  const entry = R`C:\npm\node_modules\@openai\codex\bin\codex.js`
  const files = new Set([R`C:\a\claude.exe`, R`C:\npm\codex.cmd`, entry])
  const exists = (p) => files.has(p)
  const b = resolveBins({ env: { PATH: R`C:\a;C:\npm` }, platform: 'win32', exists })
  assert.deepEqual(b.claude, [R`C:\a\claude.exe`])
  assert.deepEqual(b.codex, [process.execPath, entry])
  assert.deepEqual(resolveBins({ env: { PATH: R`C:\none` }, platform: 'win32', exists }), { claude: null, codex: null })
  const unix = new Set(['/usr/local/bin/claude'])
  assert.deepEqual(resolveBins({ env: { PATH: '/usr/bin:/usr/local/bin' }, platform: 'linux', exists: (p) => unix.has(p) }), { claude: ['/usr/local/bin/claude'], codex: null })
})
