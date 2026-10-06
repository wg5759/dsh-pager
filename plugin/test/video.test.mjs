import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createVideoPreviews } from '../video.js'

test('previews deduplicate, run serially, and publish only a completed file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-video-')), children = []
  const cache = createVideoPreviews({ dir, spawnProcess: (exe, args, opts) => {
    const c = new EventEmitter(); c.kill = () => c.emit('close', 1)
    children.push({ c, exe, args, opts }); return c
  } })
  try {
    const stat = { size: 3000000, mtimeMs: 1 }
    const first = cache.request('/input-one.mp4', stat)
    assert.equal(cache.request('/input-one.mp4', stat), first)
    const second = cache.request('/input-two.mp4', stat)
    assert.equal(children.length, 1)
    assert.equal(fs.existsSync(first.file), false)
    assert.equal(children[0].opts.windowsHide, true)
    assert.ok(!children[0].opts.shell)
    fs.writeFileSync(first.temp, 'encoded-video')
    children[0].c.emit('close', 0)
    assert.equal(first.state, 'ready')
    assert.equal(children.length, 2)
    assert.equal(cache.request('/input-one.mp4', stat).state, 'ready')
    assert.equal(children.length, 2, 'the finished cache is reused')
    const restarted = createVideoPreviews({ dir, spawnProcess: () => { throw new Error('must reuse persisted cache') } })
    assert.equal(restarted.request('/input-one.mp4', stat).state, 'ready', 'cache survives a new plugin instance')
    restarted.close()
    fs.writeFileSync(second.temp, 'incomplete')
    children[1].c.emit('close', 1)
    assert.equal(second.state, 'unavailable')
    assert.equal(fs.existsSync(second.file), false)
    assert.equal(fs.existsSync(second.temp), false)
    assert.notEqual(cache.request('/input-one.mp4', { ...stat, mtimeMs: 2 }).file, first.file)
  } finally { cache.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a missing encoder falls back without leaving a running job', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-noencoder-'))
  const cache = createVideoPreviews({ dir, spawnProcess: () => { throw new Error('missing') } })
  try {
    assert.equal(cache.request('/one.mp4', { size: 1, mtimeMs: 1 }).state, 'unavailable')
    assert.equal(cache.request('/two.mp4', { size: 1, mtimeMs: 1 }).state, 'unavailable')
  } finally { cache.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

for (const invalidation of ['missing', 'empty']) test(`a completed preview with ${invalidation} cached bytes is rebuilt and deduplicates`, () => {
  const tempRoot = fs.realpathSync(os.tmpdir())
  const dir = fs.mkdtempSync(path.join(tempRoot, 'dshp-evicted-preview-')), children = []
  const cache = createVideoPreviews({ dir, spawnProcess: () => {
    const c = new EventEmitter(); c.kill = () => c.emit('close', 1)
    children.push(c); return c
  } })
  try {
    const stat = { size: 3000000, mtimeMs: 1 }
    const first = cache.request('/fictional-source.mp4', stat)
    fs.writeFileSync(first.temp, 'encoded-before-invalidation')
    children[0].emit('close', 0)
    assert.equal(first.state, 'ready')
    if (invalidation === 'missing') fs.unlinkSync(first.file)
    else fs.truncateSync(first.file, 0)
    const second = cache.request('/fictional-source.mp4', stat)
    assert.equal(children.length, 2, 'invalid cached bytes schedule one new encoder job')
    assert.notEqual(second, first)
    assert.equal(second.state, 'preparing')
    assert.equal(cache.request('/fictional-source.mp4', stat), second, 'polling reuses the new preparing job')
    assert.equal(children.length, 2, 'polling never starts a third job')
    fs.writeFileSync(second.temp, 'rebuilt-encoded-preview')
    children[1].emit('close', 0)
    assert.equal(second.state, 'ready')
    assert.ok(fs.statSync(second.file).size > 0)
    assert.equal(cache.request('/fictional-source.mp4', stat).state, 'ready')
    assert.equal(children.length, 2)
  } finally {
    cache.close()
    assert.equal(path.dirname(fs.realpathSync(dir)), tempRoot, 'cleanup stays in the just-created test directory')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
