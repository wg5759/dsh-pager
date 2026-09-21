// Fixtures mirror line shapes seen in real Claude Code 2.1 transcripts and Codex 0.147 rollouts (2026-09-22).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { foldClaude, foldCodex, parseLines, readTail, foldFile, recentFiles } from '../transcripts.js'

const ts = '2026-09-22T01:00:00.000Z'
const claude = [
  { type: 'queue-operation', operation: 'enqueue', timestamp: ts },
  { type: 'user', timestamp: ts, cwd: 'D:\\proj\\shop', message: { role: 'user', content: '修一下首页的价格显示' } },
  { type: 'user', isMeta: true, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: C:\\x' }] } },
  { type: 'assistant', timestamp: ts, message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: '先看组件' }] } },
  { type: 'assistant', timestamp: ts, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '我先看一下。' }] } },
  { type: 'assistant', timestamp: ts, message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] } },
  { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '42 passing\r\n', is_error: false }] }, toolUseResult: { stdout: '42 passing' } },
  { type: 'assistant', timestamp: ts, message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: 'D:\\proj\\shop\\src\\Price.tsx', old_string: 'a', new_string: 'b' } }] } },
  { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'denied by the user' }], is_error: true }] } },
  { type: 'user', timestamp: ts, message: { role: 'user', content: '<command-name>/clear</command-name>' } },
  { type: 'assistant', isSidechain: true, timestamp: ts, message: { id: 'sub', role: 'assistant', content: [{ type: 'text', text: 'subagent noise' }] } },
  { type: 'assistant', timestamp: ts, message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: '改好了。' }] } },
  { type: 'custom-title', customTitle: '首页价格修复', sessionId: 's' },
]

test('Claude Code: prompts, merged assistant text, tool rows with results; noise dropped', () => {
  const f = foldClaude(claude)
  assert.equal(f.title, '首页价格修复')
  assert.deepEqual(f.items.map((i) => i.k), ['u', 'a', 't', 't', 'a'])
  assert.deepEqual([f.items[1].text, f.items[1].think], ['我先看一下。', '先看组件'])
  const [bash, edit] = [f.items[2], f.items[3]]
  assert.deepEqual([bash.title, bash.detail, bash.kind, bash.done, bash.out], ['Run tests', 'npm test', 'execute', true, '42 passing\n'])
  assert.deepEqual([edit.title, edit.err, edit.out, edit.paths], ['Edit Price.tsx', true, 'denied by the user', ['D:\\proj\\shop\\src\\Price.tsx']])
  assert.equal(foldClaude(claude.filter((o) => o.type !== 'custom-title')).title, '修一下首页的价格显示')
})

const codex = [
  { timestamp: ts, type: 'session_meta', payload: { id: 'c1', session_id: 'c1', cwd: 'E:\\repo\\api', cli_version: '0.147.0' } },
  { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system stuff' }] } },
  { timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: '给登录接口加限流' } },
  { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…' }] } },
  { timestamp: ts, type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["rg","login"]}', call_id: 'f1' } },
  { timestamp: ts, type: 'response_item', payload: { type: 'function_call_output', call_id: 'f1', output: '{"output":"src/login.ts\\n","metadata":{"exit_code":0}}' } },
  { timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/login.ts', call_id: 'p1', status: 'completed' } },
  { timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'p1', output: 'Success. Updated the following files:\nM src/login.ts' } },
  { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已加上限流。' }] } },
  { timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: '已加上限流。', duration_ms: 41000 } },
]

test('Codex: user_message events, tool calls with unwrapped outputs, turn end with duration', () => {
  const f = foldCodex(codex)
  assert.deepEqual([f.title, f.cwd], ['给登录接口加限流', 'E:\\repo\\api'])
  assert.deepEqual(f.items.map((i) => i.k), ['u', 't', 't', 'a', 'end'])
  assert.deepEqual([f.items[1].detail, f.items[1].out, f.items[1].kind], ['rg login', 'src/login.ts\n', 'execute'])
  assert.deepEqual([f.items[2].name, f.items[2].kind, f.items[2].done], ['apply_patch', 'edit', true])
  assert.equal(f.items[4].ms, 41000)
})

test('tail reads start at a line boundary; torn and junk lines are skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-tr-'))
  const file = path.join(dir, 'a.jsonl')
  fs.writeFileSync(file, claude.map((o) => JSON.stringify(o)).join('\n') + '\nnot json\n')
  const t = readTail(file, 400)
  assert.equal(t.truncated, true)
  assert.ok(parseLines(t.text).length >= 1)
  const f = foldFile(file, 'claude')
  assert.deepEqual([f.title, f.cwd, f.items.map((i) => i.seq)], ['首页价格修复', 'D:\\proj\\shop', [1, 2, 3, 4, 5]])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('recentFiles finds both layouts, newest first, within the window', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-rf-'))
  const cl = path.join(dir, 'claude', 'D--proj')
  const d = new Date()
  const cx = path.join(dir, 'codex', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
  fs.mkdirSync(cl, { recursive: true })
  fs.mkdirSync(cx, { recursive: true })
  const a = path.join(cl, '11111111-2222-3333-4444-555555555555.jsonl')
  const b = path.join(cx, 'rollout-2026-09-22T01-00-00-66666666-7777-8888-9999-000000000000.jsonl')
  fs.writeFileSync(a, '{}\n')
  fs.writeFileSync(b, '{}\n')
  fs.writeFileSync(path.join(cl, 'notes.txt'), 'x')
  const old = Date.now() / 1000 - 30 * 86400
  const c = path.join(cl, 'aaaaaaaa-2222-3333-4444-555555555555.jsonl')
  fs.writeFileSync(c, '{}\n')
  fs.utimesSync(c, old, old)
  const r = recentFiles({ claudeDir: path.join(dir, 'claude'), codexDir: path.join(dir, 'codex') })
  assert.deepEqual(r.map((x) => [x.src, x.id]).sort(), [['claude', '11111111-2222-3333-4444-555555555555'], ['codex', '66666666-7777-8888-9999-000000000000']])
  fs.rmSync(dir, { recursive: true, force: true })
})
