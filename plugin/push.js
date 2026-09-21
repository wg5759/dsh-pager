/**
 * Web Push for the web app installed on an iPhone ("Add to Home Screen",
 * iOS 16.4+): the same notices the Android app gets over /m/api/notify.
 *
 * RFC 8292 (VAPID: an ES256-signed JWT) and RFC 8291 (aes128gcm payload
 * encryption), node:crypto only. Payloads are end-to-end encrypted: the push
 * service (Apple's, for an iPhone) relays ciphertext it cannot read.
 *
 * State lives outside the repo, in `dir` (default DSH_PAGER_HOME or
 * ~/.dsh-pager):
 *   vapid.json       this server's signing key pair (created on first use)
 *   push-subs.json   subscribed devices
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const b64u = (b) => Buffer.from(b).toString('base64url')
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url')

/** Push services a subscription may point at; anything else is refused (no arbitrary outbound POSTs). */
const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com']

export function defaultDir() {
  return process.env.DSH_PAGER_HOME || path.join(os.homedir(), '.dsh-pager')
}

/**
 * Encrypt one message for one subscription (RFC 8291, a single aes128gcm record).
 * `asPrivate` and `salt` are only passed by tests, to reproduce the RFC's example.
 */
export function encrypt(plaintext, { p256dh, auth }, { asPrivate, salt } = {}) {
  const uaPublic = unb64u(p256dh)
  const authSecret = unb64u(auth)
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('bad subscription keys')
  const ecdh = crypto.createECDH('prime256v1')
  if (asPrivate) ecdh.setPrivateKey(asPrivate)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)
  salt = salt || crypto.randomBytes(16)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32))
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02: the padding delimiter of the last (only) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(4096)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body])
}

/** `Authorization` header value for one push service (RFC 8292). */
export function vapidAuth(endpoint, { publicKey, privateKey }, sub, now = Date.now()) {
  const aud = new URL(endpoint).origin
  // Apple refuses tokens valid for more than a day.
  const token = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' + b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub }))
  const sig = crypto.sign('sha256', Buffer.from(token), { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${token}.${b64u(sig)}, k=${publicKey}`
}

/** Whether `endpoint` is an https URL of a known push service. */
export function validEndpoint(endpoint) {
  let u
  try { u = new URL(endpoint) } catch { return false }
  return u.protocol === 'https:' && PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

function dur(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return s + '秒'
  const m = Math.floor(s / 60)
  if (m < 60) return m + '分' + (s % 60 ? (s % 60) + '秒' : '')
  return Math.floor(m / 60) + '小时' + (m % 60 ? (m % 60) + '分' : '')
}

/**
 * The push for one NotifyHub notice, worded like the Android notifications;
 * null for notices that are not worth a push (resolved asks, heartbeats).
 */
export function noticePayload(ev) {
  const base = { s: ev.s }
  switch (ev.t) {
    case 'ask': {
      const detail = ev.detail && ev.detail !== ev.what ? ' · ' + ev.detail : ''
      return { payload: { ...base, title: '需要你确认 · ' + (ev.title || 'DSH'), body: clip((ev.what || ev.tool || '') + detail, 180), tag: 'a:' + ev.id, sticky: true }, urgency: 'high', ttl: 6 * 3600 }
    }
    case 'q':
      return { payload: { ...base, title: 'DSH 在问你 · ' + (ev.title || 'DSH'), body: clip(ev.text, 160) + (ev.count > 1 ? `（共 ${ev.count} 个问题）` : ''), tag: 'q:' + ev.rpc, sticky: true }, urgency: 'high', ttl: 6 * 3600 }
    case 'done':
      return { payload: { ...base, title: ev.title || 'DSH', body: '已完成' + (ev.ms ? ' · ' + dur(ev.ms) : '') + (ev.preview ? '\n' + clip(ev.preview, 140) : ''), tag: 'd:' + ev.s }, urgency: 'normal', ttl: 6 * 3600 }
    case 'err':
      return { payload: { ...base, title: ev.title || 'DSH', body: '运行出错：' + clip(ev.msg, 160), tag: 'd:' + ev.s }, urgency: 'high', ttl: 6 * 3600 }
    default:
      return null
  }
}

export class WebPush {
  /**
   * @param {{ dir?: string, sub?: string, log?: (m: string) => void, fetch?: typeof fetch }} [opts]
   */
  constructor({ dir = defaultDir(), sub = 'https://github.com/wg5759/dsh-pager', log = () => {}, fetch: f = globalThis.fetch } = {}) {
    this.dir = dir
    this.subject = sub
    this.log = log
    this.fetch = f
    this.vapid = null
    this.subs = null
  }

  file(name) { return path.join(this.dir, name) }

  write(name, obj) {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = this.file(name + '.tmp')
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 })
    fs.renameSync(tmp, this.file(name))
  }

  /** The signing key pair, created and persisted on first use. */
  keys() {
    if (this.vapid) return this.vapid
    let saved = null
    try { saved = JSON.parse(fs.readFileSync(this.file('vapid.json'), 'utf8')) } catch {}
    if (!saved || !saved.jwk || !saved.publicKey) {
      const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      const jwk = privateKey.export({ format: 'jwk' })
      saved = { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])), jwk, created: new Date().toISOString() }
      this.write('vapid.json', saved)
      this.log('push: created a new VAPID key')
    }
    this.vapid = { publicKey: saved.publicKey, privateKey: crypto.createPrivateKey({ key: saved.jwk, format: 'jwk' }) }
    return this.vapid
  }

  publicKey() { return this.keys().publicKey }

  list() {
    if (!this.subs) {
      try { this.subs = JSON.parse(fs.readFileSync(this.file('push-subs.json'), 'utf8')) } catch { this.subs = [] }
      if (!Array.isArray(this.subs)) this.subs = []
    }
    return this.subs
  }

  /** Save one browser subscription (`PushSubscription.toJSON()`); the same endpoint replaces the old entry. */
  subscribe(subscription, label = '') {
    const endpoint = subscription && subscription.endpoint
    const keys = (subscription && subscription.keys) || {}
    if (!validEndpoint(endpoint)) throw Object.assign(new Error('不支持的推送地址'), { status: 400, code: 'bad-endpoint' })
    if (unb64u(keys.p256dh).length !== 65 || unb64u(keys.auth).length !== 16) throw Object.assign(new Error('订阅密钥不完整'), { status: 400, code: 'bad-keys' })
    const subs = this.list().filter((x) => x.endpoint !== endpoint)
    subs.push({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, label: clip(label, 60), at: Date.now() })
    this.subs = subs.slice(-20)
    this.write('push-subs.json', this.subs)
    return this.subs.length
  }

  unsubscribe(endpoint) {
    const before = this.list().length
    this.subs = this.list().filter((x) => x.endpoint !== endpoint)
    if (this.subs.length !== before) this.write('push-subs.json', this.subs)
    return before - this.subs.length
  }

  /** @returns {Promise<number>} the push service's HTTP status */
  async sendTo(sub, payload, { urgency = 'normal', ttl = 3600 } = {}) {
    const body = encrypt(JSON.stringify(payload), sub.keys)
    const res = await this.fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidAuth(sub.endpoint, this.keys(), this.subject),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(ttl),
        urgency,
      },
      body,
      signal: AbortSignal.timeout(20000),
    })
    return res.status
  }

  /** Send to every device; drop the ones the push service says are gone. */
  async broadcast(payload, opts) {
    const subs = this.list()
    if (!subs.length) return []
    const results = await Promise.all(subs.map((s) => this.sendTo(s, payload, opts).then((status) => ({ s, status }), (err) => ({ s, status: 0, err }))))
    const gone = results.filter((r) => r.status === 404 || r.status === 410).map((r) => r.s.endpoint)
    if (gone.length) {
      this.subs = this.list().filter((x) => !gone.includes(x.endpoint))
      this.write('push-subs.json', this.subs)
    }
    for (const r of results) if (r.status < 200 || r.status >= 300) this.log(`push: ${new URL(r.s.endpoint).hostname} -> ${r.status || (r.err && r.err.name)}`)
    return results.map((r) => r.status)
  }
}
