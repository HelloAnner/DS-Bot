import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { get } from 'node:http'
import test from 'node:test'
import { lanChat, startLan } from '../src/host/lan.js'

test('LAN serves a separate browser login and revokes its session when disabled', async t => {
  const home = await readFile(new URL('../src/host/lan/lan.html', import.meta.url))
  const calls = []
  const options = { address: '127.0.0.1', prefix: 8, port: 0, assets: { '/': [home, 'text/html'] }, chat: body => { calls.push(body); return { ok: true } } }
  const lan = await startLan(options)
  t.after(lan.close)
  const origin = new URL(lan.url).origin
  const post = (path, body, headers = {}, base = lan.url) => fetch(new URL(path, base), {
    method: 'POST', headers: { origin: new URL(base).origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  const page = await fetch(lan.url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /id="login"/)
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  const badHost = await new Promise((resolve, reject) => {
    get(lan.url, { headers: { host: 'untrusted.invalid' } }, res => { res.resume(); resolve(res.statusCode) }).on('error', reject)
  })
  assert.equal(badHost, 403)
  assert.equal((await post('/chat', { action: 'list' })).status, 401)
  assert.equal((await post('/login', { code: lan.code }, { origin: 'http://untrusted.invalid' })).status, 403)
  const login = await post('/login', { code: lan.code })
  assert.equal(login.status, 204)
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await post('/api/bot', { endpoint: 'state' }, { cookie })).status, 404)
  assert.equal((await post('/chat', { action: 'list' }, { cookie, origin: 'http://untrusted.invalid' })).status, 403)
  assert.equal((await post('/chat', { text: 'a'.repeat(81_000) }, { cookie })).status, 413)
  assert.deepEqual(calls, [])
  assert.equal((await post('/chat', { action: 'list' }, { cookie, origin })).status, 200)
  assert.deepEqual(calls, [{ action: 'list' }])
  assert.equal((await post('/login', { code: 'wrong' })).status, 401)
  assert.equal((await post('/login', { code: 'wrong' })).status, 429)
  await lan.close()
  const reopened = await startLan(options)
  t.after(reopened.close)
  assert.notEqual(reopened.code, lan.code)
  assert.equal((await post('/chat', { action: 'list' }, { cookie }, reopened.url)).status, 401)
})

test('LAN only projects public text chats and never forwards raw session IDs or arbitrary endpoints', async () => {
  const bots = { bot: { id: 'bot', name: 'Bot', instructions: 'hidden' }, private: { id: 'private', private: true } }
  const rooms = { room: { id: 'room', name: 'Room', sessions: { bot: 'session' } } }
  const calls = []
  const chat = lanChat({ state: { bots, rooms }, refresh() {}, botOf: id => bots[id], roomOf: id => rooms[id], selfOf: id => id === 'hidden-session' ? 'private' : undefined }, async (...args) => {
    calls.push(args)
    return { ok: true, value: { cursor: null, items: [
      { kind: 'user', text: 'hello', imageRefs: ['not sent'] },
      { kind: 'steps', text: 'not sent' },
      { kind: 'bot', botId: 'hidden-session', text: 'not sent' },
    ] } }
  })
  assert.deepEqual((await chat({ action: 'list' })).value, [{ kind: 'bot', id: 'bot', name: 'Bot' }, { kind: 'room', id: 'room', name: 'Room' }])
  assert.equal((await chat({ action: 'read', kind: 'bot', id: 'private' })).ok, false)
  assert.equal((await chat({ action: 'send', kind: 'bot', id: 'session', text: 'hi' })).ok, false)
  assert.equal((await chat({ action: 'secret-store', kind: 'bot', id: 'bot' })).ok, false)
  assert.deepEqual((await chat({ action: 'read', kind: 'room', id: 'room' })).value, { cursor: null, items: [{ kind: 'user', text: 'hello', name: undefined }] })
  await chat({ action: 'send', kind: 'bot', id: 'bot', text: 'hi', sessionId: 'session' })
  assert.deepEqual(calls, [['room-chat', { roomId: 'room', cursor: undefined }], ['send', { sessionId: 'bot', text: 'hi' }]])
})
