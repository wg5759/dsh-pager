import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAddress, isPrivateListen } from './forward.mjs'

test('parseAddress: ip:port and [ipv6]:port, ports 1-65535', () => {
  assert.deepEqual(parseAddress('100.64.0.5:8080'), { host: '100.64.0.5', port: 8080 })
  assert.deepEqual(parseAddress('[fd7a:115c:a1e0::5]:8080'), { host: 'fd7a:115c:a1e0::5', port: 8080 })
  for (const bad of ['', '100.64.0.5', '100.64.0.5:0', '100.64.0.5:65536', 'fd7a::5:8080', '[fd7a::5]', 'a:b:c']) {
    assert.equal(parseAddress(bad), null, bad)
  }
})

test('isPrivateListen: only loopback, RFC 1918, CGNAT and IPv6 ULA', () => {
  for (const ok of ['127.0.0.1', '10.8.0.2', '172.16.0.1', '172.31.255.1', '192.168.1.20', '100.64.0.5', '100.127.255.254', '::1', 'fd7a:115c:a1e0::5', 'fc00::1']) {
    assert.equal(isPrivateListen(ok), true, ok)
  }
  for (const bad of ['0.0.0.0', '::', '8.8.8.8', '172.32.0.1', '100.128.0.1', '192.169.0.1', '2001:db8::1', 'fe80::1', 'fc::1', 'fd0:1::1', 'pc.local', 'localhost']) {
    assert.equal(isPrivateListen(bad), false, bad)
  }
})
