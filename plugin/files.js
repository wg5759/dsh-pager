/**
 * Read-only file access for the phone's result viewer.
 *
 * Every path is confined to one root (a session's workspace): it is resolved,
 * symlinks and junctions included, and must still lie inside the root's real
 * path. Credential-looking files are hidden from listings and refused, by name
 * (keys, keystores, .env, anything called 密码 / password / token ...) and by
 * content (PEM private keys, WireGuard `PrivateKey =`).
 *
 * Threat model: whoever reaches /m/api already passed the deployment's login
 * and can ask the agent to print any file, so this adds no capability. The
 * filter exists so a credential never shows up on a phone screen by accident.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Text shipped to the phone at most (the head of larger files). */
export const TEXT_MAX = 1024 * 1024
/** Directory entries returned at most. */
export const LIST_MAX = 500

/** Streamed with Range support and shown inline by the viewer. */
export const MEDIA = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
}

const SECRET_DIRS = new Set(['.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', 'secrets', '.secrets', 'keystore'])
// Whole words only: `token.txt`, `client_secret.json`, `access-token` are
// hidden, `tokenizer.py` and `secretManager.ts` are not.
const SECRET_NAME = new RegExp([
  String.raw`^\.env(\..*)?$`, String.raw`^\.(npmrc|pypirc|netrc|git-credentials)$`, '^_netrc$',
  String.raw`^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$`, String.raw`^auth\.json$`,
  String.raw`\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|gpg|asc|ovpn)$`,
  String.raw`(^|[._\- ])(passw(or)?ds?|secrets?|tokens?|credentials?)([._\- ]|$)`,
  '密码|口令|私钥|密钥',
].join('|'), 'i')
const SECRET_CONTENT = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|^\s*PrivateKey\s*=\s*\S|PuTTY-User-Key-File-\d|aws_secret_access_key\s*=/m

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

/** Whether any segment of a root-relative path names a credential file or directory. */
export function isSecretPath(rel) {
  return String(rel).split(/[\\/]+/).filter(Boolean).some((p) => SECRET_DIRS.has(p.toLowerCase()) || SECRET_NAME.test(p))
}

/** Whether text looks like it holds a private key. */
export function looksSecret(text) {
  return SECRET_CONTENT.test(text)
}

function inside(rootReal, real) {
  const rel = path.relative(rootReal, real)
  return !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
}

/**
 * Resolve `p` (absolute, or relative to `root`) to a real path inside `root`.
 * @returns {Promise<{ real: string, rel: string, stat: fs.Stats }>}
 */
export async function confine(root, p) {
  if (!root || !path.isAbsolute(root)) throw fail(404, 'no-root', '这个对话没有工作区目录')
  let rootReal
  try { rootReal = await fs.promises.realpath(root) } catch { throw fail(404, 'no-root', '工作区目录不存在') }
  const asked = path.resolve(rootReal, p ? String(p) : '.')
  let real
  try { real = await fs.promises.realpath(asked) } catch { throw fail(404, 'not-found', '文件不存在') }
  if (!inside(rootReal, real)) throw fail(403, 'outside', '只能查看工作区里的文件')
  const rel = path.relative(rootReal, real)
  if (isSecretPath(rel) || isSecretPath(path.relative(rootReal, asked))) throw fail(403, 'secret', '疑似密钥或凭据文件，已拦截')
  const stat = await fs.promises.stat(real)
  return { real, rel, stat }
}

/** Directory listing: dirs first, then files; credential entries and escaping links left out. */
export async function list(root, p) {
  const { real, rel, stat } = await confine(root, p)
  if (!stat.isDirectory()) throw fail(400, 'not-dir', '不是文件夹')
  const rootReal = await fs.promises.realpath(root)
  const dirents = await fs.promises.readdir(real, { withFileTypes: true })
  const entries = []
  for (const d of dirents) {
    if (entries.length >= LIST_MAX) break
    const childRel = path.join(rel, d.name)
    if (isSecretPath(childRel)) continue
    const abs = path.join(real, d.name)
    try {
      if (d.isSymbolicLink() && !inside(rootReal, await fs.promises.realpath(abs))) continue
      const st = await fs.promises.stat(abs)
      entries.push({ name: d.name, dir: st.isDirectory(), size: st.isDirectory() ? undefined : st.size, at: st.mtimeMs })
    } catch {}
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : a.dir ? -1 : 1))
  return { rel: rel.split(path.sep).join('/'), entries, more: dirents.length > entries.length && entries.length >= LIST_MAX }
}

/** Decode file bytes: BOMs, UTF-8, then GB18030 (common for Chinese Windows logs). */
export function decodeText(buf, truncated) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf), enc: 'utf-16le' }
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf), enc: 'utf-16be' }
  // A cut in the middle of a multi-byte character must not demote UTF-8 to GB18030.
  for (let back = 0; back <= (truncated ? 3 : 0); back++) {
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, buf.length - back)), enc: 'utf-8' } } catch {}
  }
  try { return { text: new TextDecoder('gb18030', { fatal: true }).decode(buf), enc: 'gb18030' } } catch {}
  return { text: buf.toString('latin1'), enc: 'latin1' }
}

function isBinary(buf) {
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return false
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/**
 * What the viewer should show for one path.
 * @returns {Promise<object>} {kind:'dir'|'text'|'media'|'binary', ...}
 */
export async function describe(root, p) {
  const { real, rel, stat } = await confine(root, p)
  const relPosix = rel.split(path.sep).join('/')
  if (stat.isDirectory()) return { kind: 'dir', ...(await list(root, p)) }
  if (!stat.isFile()) throw fail(400, 'not-file', '不是普通文件')
  const name = path.basename(real)
  const ext = path.extname(name).toLowerCase()
  if (MEDIA[ext]) return { kind: 'media', rel: relPosix, name, size: stat.size, at: stat.mtimeMs, type: MEDIA[ext] }
  const fh = await fs.promises.open(real, 'r')
  let buf
  try {
    const len = Math.min(stat.size, TEXT_MAX)
    buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, 0)
  } finally { await fh.close() }
  if (isBinary(buf)) return { kind: 'binary', rel: relPosix, name, size: stat.size, at: stat.mtimeMs }
  const truncated = stat.size > TEXT_MAX
  const { text, enc } = decodeText(buf, truncated)
  if (looksSecret(text)) throw fail(403, 'secret', '内容疑似包含密钥，已拦截')
  return { kind: 'text', rel: relPosix, name, size: stat.size, at: stat.mtimeMs, enc, truncated, text }
}

/** Parse a single `bytes=a-b` range against `size`; null = whole file, false = unsatisfiable. */
export function parseRange(header, size) {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!m || (m[1] === '' && m[2] === '')) return false
  let start, end
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1 } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (!(start <= end) || start >= size) return false
  return { start, end }
}
