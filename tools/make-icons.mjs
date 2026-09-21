#!/usr/bin/env node
/**
 * Render the web app icons (plugin/www/icon-*.png) from the same artwork as
 * the Android adaptive icon: a diagonal blue gradient and a white ">_".
 * Pure Node (zlib only): distance-field strokes with round caps, 4x4
 * supersampled edges, PNG written by hand.
 *
 *   node tools/make-icons.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'www')
const SIZES = [180, 192, 512]
const C0 = [0x6f, 0x87, 0xff] // gradient start (18, 8)
const C1 = [0x35, 0x48, 0xda] // gradient end (90, 100)
const HALF = 7.5 / 2 // stroke width 7.5 in the 108-unit viewport
const SEGS = [[37, 40, 51, 54], [51, 54, 37, 68], [58, 68, 73, 68]]

function segDist(px, py, [ax, ay, bx, by]) {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

function pixel(u, v) {
  const gx = 72, gy = 92
  const t = Math.max(0, Math.min(1, ((u - 18) * gx + (v - 8) * gy) / (gx * gx + gy * gy)))
  const bg = C0.map((c, i) => c + (C1[i] - c) * t)
  const ink = Math.min(...SEGS.map((s) => segDist(u, v, s))) <= HALF ? 1 : 0
  return bg.map((c) => c + (255 - c) * ink)
}

function render(size) {
  const n = 4, px = 108 / size
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0]
      for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
        const c = pixel((x + (sx + 0.5) / n) * px, (y + (sy + 0.5) / n) * px)
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]
      }
      const o = y * (size * 3 + 1) + 1 + x * 3
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(acc[i] / (n * n))
    }
  }
  return png(size, raw)
}

const CRC = new Int32Array(256).map((_, k) => { let c = k; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c })
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0 }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, raw) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const s of SIZES) {
  const file = path.join(OUT, `icon-${s}.png`)
  fs.writeFileSync(file, render(s))
  console.log(`${path.relative(process.cwd(), file)}  ${fs.statSync(file).size} bytes`)
}
