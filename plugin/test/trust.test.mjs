import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trusted, canonicalTrustedHost, createMobile } from '../server.js'

const req = (headers) => ({ headers })

test('loopback host passes; foreign host fails without trustedHosts', () => {
  assert.equal(trusted(req({ host: '127.0.0.1:3080' })), true)
  assert.equal(trusted(req({ host: 'localhost:3080' })), true)
  assert.equal(trusted(req({ host: '[::1]:3080' })), true)
  assert.equal(trusted(req({ host: '100.64.0.5:8080' })), false)
  assert.equal(trusted(req({ host: 'evil.example' })), false)
  assert.equal(trusted(req({})), false)
})

test('trustedHosts: exact authority with a port, any port without one', () => {
  assert.equal(trusted(req({ host: '100.64.0.5:8080' }), ['100.64.0.5:8080']), true)
  assert.equal(trusted(req({ host: '100.64.0.5:9999' }), ['100.64.0.5:8080']), false)
  assert.equal(trusted(req({ host: '100.64.0.5:9999' }), ['100.64.0.5']), true)
  assert.equal(trusted(req({ host: '[fd7a::5]:8080' }), ['[fd7a::5]:8080']), true)
  assert.equal(trusted(req({ host: '[fd7a::5]:1' }), ['[fd7a::5]:8080']), false)
})

test('trustedHosts: :80 and :443 are explicit ports, as in DSH', () => {
  assert.equal(trusted(req({ host: 'pc.example' }), ['pc.example:80']), true)
  assert.equal(trusted(req({ host: 'pc.example:80' }), ['pc.example:80']), true)
  assert.equal(trusted(req({ host: 'pc.example:8080' }), ['pc.example:80']), false)
  assert.equal(trusted(req({ host: 'pc.example:443' }), ['pc.example:443']), true)
  assert.equal(trusted(req({ host: 'pc.example' }), ['pc.example:443']), false)
})

test('trustedHosts entries must be bare canonical authorities', () => {
  for (const ok of ['100.64.0.5', '100.64.0.5:8080', 'pc.example:80', 'pc.example:443', '[fd7a::5]:8080', 'PC.Example:8080']) {
    assert.notEqual(canonicalTrustedHost(ok), null, ok)
  }
  for (const bad of ['user@evil.example', 'pc.example/m', 'pc.example:', 'pc.example:08080', 'fd7a::5', ' pc.example', '', 42, null]) {
    assert.equal(canonicalTrustedHost(bad), null, String(bad))
  }
  // A malformed entry never grants anything, and fails the plugin load.
  assert.equal(trusted(req({ host: 'evil.example' }), ['user@evil.example']), false)
  assert.throws(() => createMobile({ apiPort: () => 1, trustedHosts: ['user@evil.example'] }), /not a bare host\[:port\] authority/)
})

test('origin must be same-host; cross-site fetch metadata is refused', () => {
  const t = ['100.64.0.5:8080']
  assert.equal(trusted(req({ host: '100.64.0.5:8080', origin: 'http://100.64.0.5:8080' }), t), true)
  assert.equal(trusted(req({ host: '100.64.0.5:8080', origin: 'https://evil.example' }), t), false)
  assert.equal(trusted(req({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(trusted(req({ host: '127.0.0.1:3080', origin: 'not a url' })), false)
})
