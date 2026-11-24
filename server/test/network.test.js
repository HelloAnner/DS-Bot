import assert from 'node:assert/strict'
import test from 'node:test'
import { advertisedUrl, localIPv4Addresses, networkArgs, resolveNetwork } from '../network.mjs'

test('network options default to loopback and combine explicit trusted authorities', () => {
  assert.deepEqual(resolveNetwork({}, {}), { host: '127.0.0.1', port: 3080, trustedHosts: [], publicUrl: undefined })
  const options = resolveNetwork({ port: '0', 'trusted-host': ['bot.example', '[fd00::1]:8080'] }, {
    DS_BOT_HOST: '192.168.1.20', DS_BOT_PORT: '1234', DS_BOT_TRUSTED_HOSTS: 'localhost, bot.example', DSH_TRUSTED_HOST: 'other.example',
  })
  assert.deepEqual(networkArgs(options), [
    '--host', '192.168.1.20', '--port', '0', '--trusted-host', 'localhost', '--trusted-host', 'bot.example',
    '--trusted-host', 'other.example', '--trusted-host', '[fd00::1]:8080',
  ])
  assert.equal(resolveNetwork({ host: '::1' }, { DS_BOT_PORT: '1234', DS_BOT_HOST: '192.168.1.20' }).port, 1234)
  assert.throws(() => resolveNetwork({ host: '0.0.0.0' }, {}), /concrete IP/)
  assert.throws(() => resolveNetwork({ port: '99999' }, {}), /--port/)
})

test('discovery lists unique non-loopback IPv4 interface addresses without selecting a bind', () => {
  const ipv4 = (address, internal = false) => ({ family: 'IPv4', address, internal })
  assert.deepEqual(localIPv4Addresses({
    lo: [ipv4('127.0.0.1', true), ipv4('127.0.0.2')],
    ethernet: [ipv4('192.168.1.20'), { family: 'IPv6', address: 'fd00::1', internal: false }],
    vpn: [ipv4('100.64.0.1'), ipv4('192.168.1.20')],
  }), ['100.64.0.1', '192.168.1.20'])
  assert.deepEqual(localIPv4Addresses({}), [])
})

test('advertised URL uses the bound port or a normalized proxy root without adding trust', () => {
  assert.equal(advertisedUrl(resolveNetwork({ host: '192.168.1.20', port: '0' }, {}), 43210), 'http://192.168.1.20:43210/')
  assert.equal(advertisedUrl(resolveNetwork({ host: '::1' }, {}), 43210), 'http://[::1]:43210/')
  const proxied = resolveNetwork({ 'public-url': 'https://bot.example/console' }, {})
  assert.equal(advertisedUrl(proxied, 43210), 'https://bot.example/console/')
  assert.deepEqual(proxied.trustedHosts, [])
  for (const url of ['file:///tmp', 'https://user@bot.example/', 'https://bot.example/?key=dummy', 'https://bot.example/#']) {
    assert.throws(() => resolveNetwork({ 'public-url': url }, {}), /--public-url/)
  }
})
