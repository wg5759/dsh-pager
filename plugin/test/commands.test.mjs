import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { load, save, validate, DEFAULTS, MAX } from '../commands.js'

test('quick commands: defaults first, saved list after, limits enforced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-cmd-'))
  try {
    assert.deepEqual(load(dir).items.map((c) => c.label), DEFAULTS.map((c) => c.label))
    const out = save(dir, [{ label: ' 部署预览 ', text: ' 构建并部署到预览环境，给我链接。 ' }, { id: 'test', label: '跑测试', text: 'npm test' }])
    assert.deepEqual(out.items.map((c) => [c.label, c.text]), [['部署预览', '构建并部署到预览环境，给我链接。'], ['跑测试', 'npm test']])
    assert.equal(out.items[1].id, 'test')
    assert.match(out.items[0].id, /^[0-9a-f]{8}$/)
    assert.deepEqual(load(dir), out)
    assert.throws(() => validate([{ label: '', text: 'x' }]), /不能为空/)
    assert.throws(() => validate([{ label: '一二三四五六七八九十一二三四五六七', text: 'x' }]), /16/)
    assert.throws(() => validate(Array.from({ length: MAX + 1 }, () => ({ label: 'a', text: 'b' }))), /最多/)
    assert.throws(() => validate('nope'), /格式/)
    // Duplicate ids from a hand-edited file are made unique.
    const d = validate([{ id: 'x', label: 'a', text: 'b' }, { id: 'x', label: 'c', text: 'd' }])
    assert.notEqual(d[0].id, d[1].id)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a broken commands.json is reported and kept as .bak when overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-cmd-'))
  try {
    fs.writeFileSync(path.join(dir, 'commands.json'), '{ "items": [ oops')
    const l = load(dir)
    assert.match(l.note, /有误/)
    assert.equal(l.items.length, DEFAULTS.length)
    save(dir, [{ label: '好', text: '好的' }])
    assert.equal(fs.readFileSync(path.join(dir, 'commands.json.bak'), 'utf8'), '{ "items": [ oops')
    assert.equal(load(dir).note, undefined)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
