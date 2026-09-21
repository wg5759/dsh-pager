#!/usr/bin/env node
/**
 * forward.mjs: make DSH (and so dsh-pager's /m) reachable on ONE private
 * address, typically this PC's VPN address (Tailscale, WireGuard, ZeroTier).
 *
 *   node tools/forward.mjs 100.64.0.5:8080                  # -> 127.0.0.1:3080
 *   node tools/forward.mjs 100.64.0.5:8080 127.0.0.1:3080
 *
 * DSH binds 127.0.0.1 and has no login of its own. This is a plain TCP pipe:
 * no header rewriting, so the phone's Host/Origin reach DSH unchanged and the
 * listen authority must be declared trusted, in the dsh-pager row:
 *
 *   - insert:
 *       - id: mobile
 *         name: 'dsh-pager'
 *         config:
 *           trustedHosts: ['100.64.0.5:8080']
 *
 * (and in DSH's own `trustedHosts` too if you also want the desktop UI there).
 *
 * Anyone who can reach the listen address can drive DSH, which runs commands
 * on this PC. So this refuses wildcard and public addresses and only listens on
 * loopback, RFC 1918, CGNAT/Tailscale (100.64.0.0/10) or IPv6 ULA (fc00::/7).
 * For access from the open internet put an authenticating gateway in front
 * instead (see docs/remote-access.md).
 */

import net from 'node:net'
import { pathToFileURL } from 'node:url'

const USAGE = 'usage: node tools/forward.mjs <listen-ip:port> [target-host:port, default 127.0.0.1:3080]'

/** "100.64.0.5:8080" / "[fd7a::5]:8080" -> { host, port } or null. */
export function parseAddress(s) {
  const m = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(s) || /^([^:[\]]+):(\d{1,5})$/.exec(s)
  if (!m) return null
  const port = Number(m[2])
  if (port < 1 || port > 65535) return null
  return { host: m[1], port }
}

/** Whether a listen IP is a private (non-routable) address. Hostnames are refused: they could resolve anywhere. */
export function isPrivateListen(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase()
    // fc00::/7 needs a full first group: "fc::1" is 00fc::1, not a ULA.
    return v === '::1' || /^f[cd][0-9a-f]{2}:/.test(v)
  }
  return false
}

function main(argv) {
  const listen = parseAddress(argv[0] || '')
  const target = parseAddress(argv[1] || '127.0.0.1:3080')
  if (!listen || !target) {
    console.error(USAGE)
    return 2
  }
  if (!isPrivateListen(listen.host)) {
    console.error(`forward: refusing to listen on ${listen.host}: not a private IP address (DSH has no login).`)
    console.error('         Use this PC\'s VPN or LAN address, or put an authenticating gateway in front.')
    return 2
  }
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: target.host, port: target.port })
    // Live streams (SSE) idle for minutes between frames; keep NAT and VPN paths warm.
    for (const s of [client, upstream]) {
      s.setNoDelay(true)
      s.setKeepAlive(true, 30000)
    }
    const close = () => {
      client.destroy()
      upstream.destroy()
    }
    client.on('error', close)
    upstream.on('error', close)
    client.on('close', close)
    upstream.on('close', close)
    client.pipe(upstream).pipe(client)
  })
  server.on('error', (e) => {
    console.error(`forward: ${e.message}`)
    process.exit(1)
  })
  const show = (a) => (a.host.includes(':') ? `[${a.host}]:${a.port}` : `${a.host}:${a.port}`)
  server.listen(listen.port, listen.host, () => {
    console.log(`forwarding ${show(listen)} -> ${show(target)}`)
    console.log(`add '${show(listen)}' to the dsh-pager row's trustedHosts, then open http://${show(listen)}/m/`)
  })
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = main(process.argv.slice(2))
  if (code) process.exit(code)
}
