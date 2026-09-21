import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encrypt, vapidAuth, validEndpoint, noticePayload, WebPush } from '../push.js'

const B = (s) => Buffer.from(s.replace(/\s+/g, ''), 'base64url')

test('encrypt reproduces the RFC 8291 section 5 example byte for byte', () => {
  const out = encrypt('When I grow up, I want to be a watermelon', {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }, { asPrivate: B('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: B('DGv6ra1nlYgDCS1FRnbzlw') })
  const header = B(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8`)
  const ciphertext = B(`8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ`)
  assert.equal(header.length, 86)
  assert.deepEqual(out, Buffer.concat([header, ciphertext]))
})

test('encrypt with a fresh key decrypts on the receiving side', () => {
  const ua = crypto.createECDH('prime256v1')
  ua.generateKeys()
  const auth = crypto.randomBytes(16)
  const msg = JSON.stringify({ title: '需要你确认 · 测试', body: 'rm -rf node_modules' })
  const out = encrypt(msg, { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') })
  // Receiver per RFC 8291 section 3.
  const salt = out.subarray(0, 16), asPublic = out.subarray(21, 86), body = out.subarray(86)
  const shared = ua.computeSecret(asPublic)
  const ikm = crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32)
  const cek = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ikm), salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ikm), salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(body.subarray(body.length - 16))
  const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()])
  assert.equal(plain[plain.length - 1], 2)
  assert.equal(plain.subarray(0, -1).toString(), msg)
})

test('vapidAuth: ES256 JWT for the endpoint origin, verifiable with the public key', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' })
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url')
  const now = Date.UTC(2026, 8, 22)
  const h = vapidAuth('https://web.push.apple.com/QGw-abc?x=1', { publicKey, privateKey }, 'https://example.com', now)
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)
  assert.ok(m)
  assert.equal(m[4], publicKey)
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'))
  assert.deepEqual(claims, { aud: 'https://web.push.apple.com', exp: now / 1000 + 12 * 3600, sub: 'https://example.com' })
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' })
  assert.equal(crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')), true)
})

test('validEndpoint: https push services only', () => {
  for (const ok of ['https://web.push.apple.com/abc', 'https://fcm.googleapis.com/fcm/send/x', 'https://wns2-sg2p.notify.windows.com/w/?token=1', 'https://updates.push.services.mozilla.com/wpush/v2/x']) assert.equal(validEndpoint(ok), true, ok)
  for (const bad of ['http://web.push.apple.com/abc', 'https://evil.example/push', 'https://push.apple.com.evil.example/x', 'https://127.0.0.1/x', 'not a url', undefined]) assert.equal(validEndpoint(bad), false, String(bad))
})

test('noticePayload: worded like the Android notifications', () => {
  assert.deepEqual(noticePayload({ t: 'ask', s: 's1', title: '部署', id: 'a1', what: 'pwsh', detail: 'Remove-Item x' }).payload,
    { s: 's1', title: '需要你确认 · 部署', body: 'pwsh · Remove-Item x', tag: 'a:a1', sticky: true })
  assert.equal(noticePayload({ t: 'q', s: 's1', title: 'T', rpc: 'r', text: '选哪个？', count: 2 }).payload.body, '选哪个？（共 2 个问题）')
  assert.equal(noticePayload({ t: 'done', s: 's1', title: 'T', ms: 95000, preview: '好了' }).payload.body, '已完成 · 1分35秒\n好了')
  assert.equal(noticePayload({ t: 'err', s: 's1', title: 'T', msg: 'boom' }).urgency, 'high')
  for (const t of ['askDone', 'qDone', 'hello', 'p']) assert.equal(noticePayload({ t }), null)
})

test('WebPush: subscriptions persist, validate, dedupe; gone devices are pruned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-push-'))
  const ua = crypto.createECDH('prime256v1')
  ua.generateKeys()
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }
  const calls = []
  const fake = async (url, init) => { calls.push({ url, init }); return { status: url.includes('gone') ? 410 : 201 } }
  const p = new WebPush({ dir, fetch: fake })
  assert.throws(() => p.subscribe({ endpoint: 'https://evil.example/x', keys }), /不支持/)
  assert.throws(() => p.subscribe({ endpoint: 'https://web.push.apple.com/a', keys: { p256dh: 'x', auth: 'y' } }), /密钥/)
  p.subscribe({ endpoint: 'https://web.push.apple.com/a', keys }, 'iPhone')
  p.subscribe({ endpoint: 'https://web.push.apple.com/a', keys }, 'iPhone again')
  p.subscribe({ endpoint: 'https://web.push.apple.com/gone', keys })
  assert.equal(new WebPush({ dir }).list().length, 2) // persisted, deduplicated
  const statuses = await p.broadcast({ title: 't' }, { urgency: 'high', ttl: 60 })
  assert.deepEqual(statuses.sort(), [201, 410])
  assert.deepEqual(p.list().map((s) => s.endpoint), ['https://web.push.apple.com/a'])
  const h = calls[0].init.headers
  assert.deepEqual([h['content-encoding'], h.ttl, h.urgency, /^vapid t=/.test(h.authorization)], ['aes128gcm', '60', 'high', true])
  assert.equal(new WebPush({ dir }).publicKey(), p.publicKey()) // key persisted
  assert.equal(p.unsubscribe('https://web.push.apple.com/a'), 1)
  fs.rmSync(dir, { recursive: true, force: true })
})
