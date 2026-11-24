import assert from 'node:assert/strict'
import { fork, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { isServerStart, listenLoopback, stopForeground } from '../index.mjs'
import { serverProcess } from '../home-lock.mjs'

const CLI = fileURLToPath(new URL('../index.mjs', import.meta.url))

test('loopback forwards HTTP to the same server and stops on shutdown', async t => {
  const controller = new AbortController()
  const primary = createServer((req, res) => res.end(req.headers.host))
  t.after(() => { controller.abort(); primary.closeAllConnections(); primary.close() })
  primary.listen(0, '::1')
  await once(primary, 'listening')
  const { port } = primary.address()
  const loopback = await listenLoopback('::1', port, controller.signal)
  const url = `http://127.0.0.1:${port}`
  assert.equal(await (await fetch(url)).text(), `127.0.0.1:${port}`)
  const closed = once(loopback, 'close')
  controller.abort()
  await closed
  await assert.rejects(fetch(url), { name: 'TypeError' })
})

test('isolated headless boot: HTTP, owner API, and shutdown', { timeout: 45000 }, async t => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), '.dsh-test-server-')))
  const env = { PATH: process.env.PATH, HOME: dir, DSH_HOME: dir, DO_NOT_TRACK: '1' }
  const child = fork(CLI, ['start', '--home', dir, '--port', '0', '--trusted-host', 'bot.example'], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env,
  })
  const exited = once(child, 'exit')
  const closed = once(child, 'close')
  t.after(async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    } finally {
      rmSync(dir, { recursive: true, force: true })
      assert.equal(existsSync(dir), false)
    }
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', chunk => { output += chunk })
  const launch = await Promise.race([
    once(child, 'message').then(([message]) => message),
    exited.then(([code, signal]) => { throw new Error(`Server exited before readiness (${code ?? signal})${output.match(/^ds-bot-server:.*$/gm)?.join(' ').replace(/token=[^\s]+/g, 'token=[redacted]') ?? ''}`) }),
  ])
  assert.equal(launch.type, 'ready')
  const urlFile = join(dir, '.launch-url')
  const clipboard = join(dir, 'clipboard')
  const pbcopy = join(dir, 'pbcopy')
  writeFileSync(pbcopy, '#!/bin/sh\numask 077\ncat > "$HOME/clipboard"\n', { mode: 0o700 })
  const copyUrl = () => spawnSync(process.execPath, [CLI, 'copy-url', '--home', dir], {
    cwd: dir, env: { ...env, DS_BOT_PBCOPY: pbcopy }, encoding: 'utf8', timeout: 6000,
  })
  const infoFile = lstatSync(urlFile)
  assert.equal(infoFile.isFile(), true)
  assert.equal(infoFile.mode & 0o777, 0o600)
  assert.equal(readFileSync(urlFile, 'utf8') === launch.url, true)
  chmodSync(urlFile, 0o644)
  const exposed = copyUrl()
  assert.equal(exposed.status, 1)
  assert.match(exposed.stderr, /private regular file/)
  assert.equal(existsSync(clipboard), false)
  chmodSync(urlFile, 0o600)
  const copied = copyUrl()
  assert.equal(copied.status, 0)
  assert.equal(copied.stdout === 'Copied the authenticated launch URL to your clipboard.\n', true)
  assert.equal(copied.stderr === '', true)
  assert.equal(readFileSync(clipboard, 'utf8') === launch.url, true)
  const base = new URL('/', launch.url)
  const token = new URL(launch.url).searchParams.get('token')
  assert.ok(token)
  const anonymous = await fetch(base)
  assert.equal(anonymous.status, 401)
  await anonymous.body?.cancel()
  const request = (endpoint, cookie) => fetch(new URL('/api/bot', base), {
    method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ endpoint, payload: {} }),
  })
  const throughProxy = host => new Promise((resolve, reject) => {
    const req = httpRequest(new URL('/api/bot', base), {
      method: 'POST', headers: { host, origin: `https://${host}`, 'content-type': 'application/json' },
    }, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    req.on('error', reject)
    req.end(JSON.stringify({ endpoint: 'state', payload: {} }))
  })
  const trustedProxy = await throughProxy('bot.example')
  const untrustedProxy = await throughProxy('other.example')
  assert.equal(trustedProxy, 401)
  assert.equal(untrustedProxy, 403)
  const denied = await request('state')
  assert.equal(denied.status, 401)
  await denied.body?.cancel()
  const login = await fetch(launch.url, { redirect: 'manual' })
  assert.equal(login.status, 303)
  const cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
  assert.ok(cookie.length > 0)
  await login.body?.cancel()
  const page = await fetch(base, { headers: { cookie } })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<html\b/i)
  const state = await request('state', cookie)
  assert.equal(state.status, 200)
  const roster = await state.json()
  assert.equal(roster.ok, true)
  assert.equal(roster.value.permissions.defaultPreset, 'danger-full-access')
  assert.equal(roster.value.browserMode, 'server')
  const serverInfo = await request('server-info', cookie)
  const info = await serverInfo.json()
  if (process.platform === 'darwin') await stopForeground(dir)
  else assert.equal(child.kill('SIGTERM'), true)
  assert.deepEqual(await exited, [0, null])
  await closed
  const lock = join(dir, '.server.lock')
  assert.equal(existsSync(lock), false)
  assert.equal(existsSync(urlFile), false)
  assert.equal(output.includes(token), false, 'Server output must not contain the launch token')

  // A force-killed process could leave both files behind. Neither makes it live.
  mkdirSync(lock, { mode: 0o700 })
  writeFileSync(join(lock, '00000000-0000-4000-8000-000000000000.json'), JSON.stringify({ pid: child.pid }))
  writeFileSync(urlFile, launch.url, { mode: 0o600 })
  rmSync(clipboard)
  const stopped = copyUrl()
  assert.equal(stopped.status, 1)
  assert.equal(stopped.stdout === '', true)
  assert.equal(stopped.stderr.includes(token), false)
  assert.match(stopped.stderr, /server is not running/)
  assert.equal(existsSync(clipboard), false)
  t.diagnostic(`GET / ${page.status}; POST state without cookie ${denied.status}, with cookie ${state.status}; POST server-info ${serverInfo.status}, ok=${info.ok}; trusted host ${trustedProxy}, untrusted host ${untrustedProxy}; SIGTERM exit 0`)
  assert.equal(serverInfo.status, 200)
  assert.equal(info.ok, true)
  assert.equal(info.value.enabled, true)
  assert.equal(info.value.unrestricted, true)
  assert.equal(info.value.dshHome, dir)
  assert.equal(info.value.canRestart, false)
})

test('foreground stop classifies the parsed server subcommand, even after options', () => {
  for (const entry of [CLI, 'server/index.mjs', '/fixture/DS Bot/server/index.mjs']) {
    const node = '/fixture/Node Tools/bin/node'
    const command = `${node} --stack-trace-limit=10 ${entry}`
    assert.equal(isServerStart(command), true)
    for (const start of ['', ' start']) {
      for (const port of ['', ' --port 0']) {
        assert.equal(isServerStart(`${command}${start} --home /fixture/server data${port}`), true)
      }
    }
    assert.equal(isServerStart(`${command} --home=/fixture/server data --port 0`), true)
    assert.equal(isServerStart(`${command} --home /fixture/server data status`), false)
    const ambiguous = `${command} --home /fixture/server status --port 0`
    assert.equal(isServerStart(ambiguous), false)
    assert.equal(isServerStart(ambiguous, ['/fixture/server']), false)
    assert.equal(isServerStart(ambiguous, ['/fixture/server status']), true)
    const homes = ['/fixture/server', '/fixture/server status']
    for (const start of ['', ' start']) {
      for (const separator of [' ', '=']) {
        assert.equal(isServerStart(`${command}${start} --home${separator}/fixture/server status`, homes), true)
      }
    }
    assert.equal(isServerStart(`${command} --home /fixture/server status --port 0`, ['/fixture/serve']), false)
    assert.equal(isServerStart(`${command} status --home /fixture/server data --port 0`), false)
    for (const args of ['--home ./server status --port 0', '--home server status', '--home=./server status',
      '--home ../parent/server status', '--home ./foo/../server status']) {
      assert.equal(isServerStart(`${command} ${args}`, ['/parent/server status'], '/parent'), true)
    }
    assert.equal(isServerStart(`${command} --home ./server status status`, ['/parent/server'], '/parent'), false)
    assert.equal(isServerStart(`${command} --invalid`), false)
    for (const flag of ['--eval', '--print', '-e', '-p']) {
      assert.equal(isServerStart(`${node} ${flag} ${entry} start`), false)
    }
    assert.equal(isServerStart(`${node} unrelated.mjs ${entry} start`), false)
  }
})

for (const [label, portArgs, relativeHome] of [
  ['--home last', [], false], ['--port after --home', ['--port', '0'], false], ['relative --home', ['--port', '0'], true],
]) {
  test(`foreground stop accepts implicit start with ${label}`, {
    skip: process.platform !== 'darwin', timeout: 15000,
  }, async t => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), '.dsh-test-server-implicit-')))
    const dir = join(root, 'server status')
    mkdirSync(dir)
    const child = fork(CLI, ['--home', relativeHome ? './server status' : dir, ...portArgs], {
      cwd: relativeHome ? root : dir, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { PATH: process.env.PATH, HOME: dir, DSH_HOME: dir, DS_BOT_PORT: '0', DO_NOT_TRACK: '1' },
    })
    const exited = once(child, 'exit')
    t.after(async () => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
    const ready = await Promise.race([
      once(child, 'message').then(([message]) => message.type),
      exited.then(([code, signal]) => `exited before readiness (${code ?? signal})`),
    ])
    assert.equal(ready, 'ready')
    await stopForeground(dir)
    assert.deepEqual(await exited, [0, null])
    assert.equal(existsSync(join(dir, '.server.lock')), false)
    assert.equal(existsSync(join(dir, '.launch-url')), false)
  })
}

test('foreground stop refuses an unrelated live PID even with its real start timestamp', {
  skip: process.platform !== 'darwin', timeout: 5000,
}, async t => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), '.dsh-test-server-stop-')))
  const script = join(dir, 'unrelated.mjs')
  writeFileSync(script, "process.send('ready'); setInterval(() => {}, 1000)\n")
  const child = fork(script, [CLI, 'start'], { cwd: dir, env: { HOME: dir }, silent: true })
  const exited = once(child, 'exit')
  t.after(async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  await once(child, 'message', { signal: AbortSignal.timeout(3000) })
  const holder = serverProcess(child.pid)
  assert.equal(holder?.uid, process.getuid())
  assert.ok(holder.started)
  const lock = join(dir, '.server.lock')
  mkdirSync(lock, { mode: 0o700 })
  writeFileSync(join(lock, '00000000-0000-4000-8000-000000000000.json'), JSON.stringify({ pid: child.pid, started: holder.started }))
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { stopForeground } from ${JSON.stringify(new URL('../index.mjs', import.meta.url).href)}
    try { await stopForeground(process.argv[1]) } catch (error) { console.error(error.message); process.exitCode = 1 }
  `, dir], { cwd: dir, env: { HOME: dir }, encoding: 'utf8', timeout: 3000 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /No signal was sent/)
  assert.equal(child.kill(0), true)
})
