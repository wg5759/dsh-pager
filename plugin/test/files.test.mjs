import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { confine, list, describe, isSecretPath, looksSecret, decodeText, parseRange, TEXT_MAX } from '../files.js'

let base, root, outside

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-files-'))
  root = path.join(base, 'ws')
  outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
  fs.mkdirSync(path.join(root, 'keystore'))
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(root, 'a.txt'), '你好 hello\n')
  fs.writeFileSync(path.join(root, 'gbk.log'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a])) // "中文\n" in GB18030
  fs.writeFileSync(path.join(root, 'u16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('PS 输出', 'utf16le')]))
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]))
  fs.writeFileSync(path.join(root, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  fs.writeFileSync(path.join(root, '.env'), 'KEY=1')
  fs.writeFileSync(path.join(root, '密码.txt'), 'x')
  fs.writeFileSync(path.join(root, 'tokenizer.py'), 'print(1)')
  fs.writeFileSync(path.join(root, 'sub', 'server.pem'), 'x')
  fs.writeFileSync(path.join(root, 'sub', 'notes.md'), '# 报告')
  fs.writeFileSync(path.join(root, 'keystore', 'dsh.jks'), 'x')
  fs.writeFileSync(path.join(root, 'wg.conf'), '[Interface]\nPrivateKey = abc123=\n')
  fs.writeFileSync(path.join(outside, 'leak.txt'), 'outside')
  fs.symlinkSync(outside, path.join(root, 'escape'), 'junction')
})

after(() => fs.rmSync(base, { recursive: true, force: true }))

test('confine: relative and absolute paths inside the root resolve', async () => {
  assert.equal((await confine(root, 'a.txt')).rel, 'a.txt')
  assert.equal((await confine(root, path.join(root, 'sub', 'notes.md'))).rel, path.join('sub', 'notes.md'))
  assert.equal((await confine(root, '')).stat.isDirectory(), true)
})

test('confine: traversal, other absolute paths and junction escapes are refused', async () => {
  for (const p of ['../outside/leak.txt', path.join(outside, 'leak.txt'), 'escape/leak.txt', 'sub/../../outside/leak.txt']) {
    await assert.rejects(confine(root, p), (e) => e.status === 403 && e.code === 'outside', p)
  }
  await assert.rejects(confine(root, 'nope.txt'), (e) => e.status === 404)
  await assert.rejects(confine('relative/root', 'a.txt'), (e) => e.status === 404 && e.code === 'no-root')
})

test('secret files: refused by name and hidden from listings', async () => {
  for (const p of ['.env', '密码.txt', 'sub/server.pem', 'keystore/dsh.jks', 'keystore']) {
    await assert.rejects(confine(root, p), (e) => e.status === 403 && e.code === 'secret', p)
  }
  const names = (await list(root, '')).entries.map((e) => e.name)
  assert.deepEqual(names, ['sub', 'a.txt', 'bin.dat', 'gbk.log', 'shot.png', 'tokenizer.py', 'u16.txt', 'wg.conf'])
})

test('isSecretPath: whole words, not substrings', () => {
  for (const p of ['client_secret.json', 'access-token', 'secrets/db.yml', '.git/config', 'a/.ssh/known_hosts', 'id_ed25519', 'my passwords.txt', '私钥备份.txt', 'x.ovpn']) {
    assert.equal(isSecretPath(p), true, p)
  }
  for (const p of ['tokenizer.py', 'secretManager.ts', 'src/app.js', 'README.md', 'keys.ts']) {
    assert.equal(isSecretPath(p), false, p)
  }
  assert.equal(looksSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nabc'), true)
  assert.equal(looksSecret('a doc that mentions private keys'), false)
})

test('describe: text encodings, binary, media, directories', async () => {
  assert.deepEqual(await describe(root, 'a.txt').then((d) => [d.kind, d.enc, d.text]), ['text', 'utf-8', '你好 hello\n'])
  assert.deepEqual(await describe(root, 'gbk.log').then((d) => [d.enc, d.text]), ['gb18030', '中文\n'])
  assert.deepEqual(await describe(root, 'u16.txt').then((d) => [d.enc, d.text]), ['utf-16le', 'PS 输出'])
  assert.equal((await describe(root, 'bin.dat')).kind, 'binary')
  assert.deepEqual(await describe(root, 'shot.png').then((d) => [d.kind, d.type]), ['media', 'image/png'])
  assert.equal((await describe(root, 'sub')).kind, 'dir')
  await assert.rejects(describe(root, 'wg.conf'), (e) => e.status === 403 && e.code === 'secret')
})

test('describe: a cut through a UTF-8 character at the size limit stays UTF-8', async () => {
  const big = path.join(root, 'big.txt')
  fs.writeFileSync(big, 'a'.repeat(TEXT_MAX - 1) + '中文')
  const d = await describe(root, 'big.txt')
  assert.equal(d.truncated, true)
  assert.equal(d.enc, 'utf-8')
  assert.equal(d.text.length, TEXT_MAX - 1)
  fs.rmSync(big)
})

test('decodeText and parseRange', () => {
  assert.equal(decodeText(Buffer.from('plain')).enc, 'utf-8')
  assert.deepEqual(parseRange(undefined, 100), null)
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 })
  assert.equal(parseRange('bytes=100-', 100), false)
  assert.equal(parseRange('bytes=-', 100), false)
  assert.equal(parseRange('items=0-1', 100), false)
})
