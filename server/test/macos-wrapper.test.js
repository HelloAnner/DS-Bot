import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const packedFiles = ['client.js', 'index.js', 'plugin.js', 'link.js', 'office.js', 'web-search.js', 'cordis.patch.yml', 'package.json',
  'bin/doctor.mjs', 'src/host/bot.js', 'src/shared/schema.js', 'src/office/worker.js']

test('macOS wrapper dry run chooses a native Node, plans stale builds, and discovers bind/trust arguments', {
  skip: process.platform !== 'darwin',
}, t => {
  const root = mkdtempSync(join(tmpdir(), '.dsh-test-server-wrapper-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    assert.equal(existsSync(root), false)
  })
  const put = (path, text, mode) => {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text, { mode })
  }
  for (const path of ['scripts/server-macos.sh', 'server/index.mjs', 'server/home-lock.mjs', 'server/launchd.mjs', 'server/network.mjs']) {
    const dest = join(root, path)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(new URL(`../../${path}`, import.meta.url), dest)
  }
  for (const path of packedFiles) {
    put(`ds-bot/${path}`, 'fixture\n')
    put(`server/node_modules/ds-bot/${path}`, 'fixture\n')
  }
  for (const name of ['client', 'link']) put(`ds-bot/scripts/build-${name}.mjs`, 'process.exit(0)\n')
  const linkInputs = ['link/src/index.ts', 'link/package.json']
  for (const path of linkInputs) put(path, 'fixture\n')
  for (const project of ['link', 'ds-bot']) mkdirSync(join(root, project, 'node_modules'), { recursive: true })
  const past = Date.now() / 1000 - 60
  for (const path of [...packedFiles.map(path => `ds-bot/${path}`), ...linkInputs]) utimesSync(join(root, path), past, past)
  put('bin/tailscale', '#!/bin/sh\nprintf "%s\\n" "$TEST_TAILSCALE"\n', 0o700)
  put('bin/scutil', '#!/bin/sh\nprintf "fixture-mac\\n"\n', 0o700)
  put('bin/ipconfig', '#!/bin/sh\n[ "$2" = en1 ] && printf "%s\\n" "$TEST_LAN"\n', 0o700)
  put('network.cjs', `
    require('node:os').networkInterfaces = () => ({ fixture: (process.env.TEST_ADDRESS || '').split(' ').filter(Boolean)
      .map(address => ({ address, family: 'IPv4', internal: false })) })
    require('node:dns').lookup = (host, options, done) => done(null, [{ address: process.env.TEST_DNS }])
  `)

  const home = join(root, 'home')
  const serverHome = join(root, 'server data')
  const plists = join(root, 'LaunchAgents')
  const run = (action, env = {}) => {
    const result = spawnSync('/bin/bash', ['scripts/server-macos.sh', action, '--dry-run'], {
      cwd: root, encoding: 'utf8', timeout: 10000, env: {
        HOME: home, SERVER_HOME: serverHome, PLIST_DIR: plists,
        PATH: `${dirname(process.execPath)}:${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
        NODE_OPTIONS: `--require=${join(root, 'network.cjs')}`, ...env,
      },
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    for (const dir of [home, serverHome, plists]) assert.equal(existsSync(dir), false)
    return result.stdout
  }
  const tail = run('start', {
    TEST_TAILSCALE: JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['fd7a::1', '100.81.1.2'], DNSName: 'mini.tail.example.' } }),
    TEST_DNS: '100.81.1.2', TRUSTED_HOSTS: 'a.example,b.example c.example:1234',
  })
  assert.match(tail, /packed DS Bot plugin is current/)
  const argv = tail.match(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/u)[1]
  assert.equal(argv.startsWith(`<string>${process.execPath}</string>`), true)
  assert.equal(tail.includes(`<key>PATH</key><string>${dirname(process.execPath)}:`), true)
  assert.equal(tail.includes(':/opt/homebrew/bin:/usr/local/bin:'), true)
  for (const [flag, value] of [['--host', '100.81.1.2'], ['--port', '54674'], ['--public-url', 'http://mini:54674/'],
    ...['fixture-mac', 'fixture-mac.local', 'mini.tail.example', 'mini', 'a.example', 'b.example', 'c.example:1234']
      .map(host => ['--trusted-host', host])]) {
    assert.equal(argv.includes(`<string>${flag}</string><string>${value}</string>`), true, `${flag} ${value}`)
  }
  assert.match(run('restart', { TEST_ADDRESS: '192.168.0.9 100.64.2.3', TEST_LAN: '192.168.0.10' }),
    /Build and refresh[\s\S]*<string>--host<\/string><string>100\.64\.2\.3<\/string>/)
  for (const path of ['ds-bot/bin/doctor.mjs', 'ds-bot/link.js', ...linkInputs]) {
    put(path, 'changed\n')
    assert.match(run('start'), /Build and refresh/, path)
    put(path, 'fixture\n')
    utimesSync(join(root, path), past, past)
    assert.match(run('start'), /packed DS Bot plugin is current/, path)
  }
  put('ds-bot/src/host/bot.js', 'backend edit\n')
  assert.match(run('start', { TEST_ADDRESS: '192.168.0.9', TEST_LAN: '192.168.0.10' }),
    /Build and refresh[\s\S]*<string>--host<\/string><string>192\.168\.0\.10<\/string>/)
  assert.match(run('start', { TEST_ADDRESS: '192.168.0.9', HOST: '127.0.0.2', PORT: '443', PUBLIC_URL: 'https://proxy.example/bot/' }),
    /<string>--host<\/string><string>127\.0\.0\.2<\/string><string>--port<\/string><string>443<\/string>[\s\S]*<string>--trusted-host<\/string><string>proxy\.example<\/string><string>--public-url<\/string><string>https:\/\/proxy\.example\/bot\/<\/string>/)
  assert.match(run('start'), /<string>--host<\/string><string>127\.0\.0\.1<\/string>/)
})

test('macOS wrapper skips first-run import for a configured Bot home', { skip: process.platform !== 'darwin' }, t => {
  const root = mkdtempSync(join(tmpdir(), '.dsh-test-server-custom-bot-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const serverHome = join(root, 'server data')
  const plists = join(root, 'LaunchAgents')
  const profile = join(serverHome, 'profiles', 'ds-bot-server')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: bot\n  config:\n    home: custom bot\n')
  const custom = join(serverHome, 'custom bot')
  mkdirSync(custom)
  const run = action => {
    const result = spawnSync('/bin/bash', ['scripts/server-macos.sh', action, '--dry-run'], {
      cwd: new URL('../..', import.meta.url), encoding: 'utf8', timeout: 10000,
      env: { HOME: home, SERVER_HOME: serverHome, PLIST_DIR: plists, HOST: '127.0.0.1',
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  assert.match(run('start'), /Try first-run import/)
  writeFileSync(join(custom, 'state.json'), JSON.stringify({ bots: { main: { id: 'main' } } }))
  for (const action of ['start', 'restart']) assert.match(run(action), /Bot state exists; skip first-run import/)
  for (const path of [home, plists, join(serverHome, 'bot')]) assert.equal(existsSync(path), false)
})
