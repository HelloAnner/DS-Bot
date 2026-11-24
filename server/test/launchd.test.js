import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { agentFiles, manageAgent } from '../launchd.mjs'

test('LaunchAgent dry run makes no files or calls; lifecycle uses the GUI domain', t => {
  const temp = mkdtempSync(join(tmpdir(), '.dsh-test-server-launchd-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const env = { HOME: temp, USERPROFILE: temp, APPDATA: temp, XDG_CONFIG_HOME: temp, DS_BOT_HOME: '', DS_BOT_SHELL_DATA: '' }
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
  const options = {
    home: join(temp, 'bot & data'), plistDir: join(temp, 'agents'),
    args: ['/node', '/code/index.mjs', 'start', '--public-url', 'https://bot.example/<entry>'],
    path: '/usr/bin:/bin', platform: 'darwin',
  }
  const calls = []
  let loaded = false
  options.run = (...args) => {
    calls.push(args)
    if (args[0] === 'print' && !loaded) throw Object.assign(new Error('not loaded'), { status: 113 })
    if (args[0] === 'bootstrap') loaded = true
    if (args[0] === 'bootout') loaded = false
    return 'state = running'
  }
  const { plist, log } = agentFiles(options.home, options.plistDir)
  const text = manageAgent('install-agent', { ...options, dryRun: true })
  assert.equal(existsSync(plist), false)
  assert.deepEqual(calls, [])
  assert.match(text, /bot &amp; data/)
  assert.match(text, /&lt;entry&gt;/)
  assert.match(text, /DS_BOT_SUPERVISED/)
  if (process.platform === 'darwin') execFileSync('/usr/bin/plutil', ['-lint', '-'], { input: text })
  assert.equal(manageAgent('status', options), 'LaunchAgent not installed.')
  manageAgent('install-agent', options)
  assert.equal(readFileSync(plist, 'utf8'), text)
  assert.equal(existsSync(log), true)
  writeFileSync(log, 'Ready at http://localhost/?token=synthetic-launch-token\nReady at http://localhost/\n')
  assert.equal(manageAgent('logs', options), 'Ready at http://localhost/?token=[redacted]\nReady at http://localhost/\n')
  assert.throws(() => manageAgent('install-agent', options), /already installed/)
  manageAgent('restart', options)
  manageAgent('stop', options)
  assert.equal(manageAgent('status', options), 'LaunchAgent installed, not loaded.')
  manageAgent('restart', options)
  manageAgent('uninstall-agent', options)
  assert.equal(existsSync(plist), false)
  assert.deepEqual(calls.filter(([action]) => action !== 'print').map(([action]) => action), ['bootstrap', 'kill', 'bootout', 'bootstrap', 'bootout'])
  assert.ok(calls.every(args => args.some(arg => arg.startsWith(`gui/${process.getuid?.()}`))))
})

const CLI = fileURLToPath(new URL('../index.mjs', import.meta.url))

test('foreground and LaunchAgent refuse protected paths through symlinks before file I/O', { skip: process.platform === 'win32' }, t => {
  const temp = mkdtempSync(join(tmpdir(), '.dsh-test-server-protection-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const home = join(temp, 'home')
  const dsh = join(home, '.dsh')
  const desktop = join(temp, 'active desktop data')
  const appData = process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : join(home, '.config')
  const shell = join(appData, 'DS Bot')
  const agentDir = join(temp, 'agents')
  const server = join(temp, 'server')
  for (const dir of [dsh, desktop, shell, server]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(shell, 'locations.json'), JSON.stringify({ dataDir: desktop }))
  const alias = join(temp, 'dsh-alias')
  const moved = join(temp, 'desktop-alias')
  symlinkSync(dsh, alias)
  symlinkSync(desktop, moved)
  writeFileSync(join(desktop, 'server.log'), 'protected fixture\n')
  symlinkSync(join(desktop, 'server.log'), join(server, 'server.log'))
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config') }
  const reject = (command, data, plistDir = agentDir) => {
    const result = spawnSync(process.execPath, [CLI, command, '--home', data, '--plist-dir', plistDir], { cwd: temp, env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /outside ~\/\.dsh and the desktop app data directory/)
  }
  reject('start', join(alias, 'new'))
  reject('install-agent', join(alias, 'new'))
  reject('install-agent', join(moved, 'new'))
  reject('logs', moved)
  reject('logs', server)
  reject('install-agent', join(temp, 'unused-server'), join(moved, 'new-agents'))
  assert.equal(existsSync(join(dsh, 'new')), false)
  assert.equal(existsSync(join(desktop, 'new')), false)
  assert.equal(existsSync(join(desktop, 'new-agents')), false)
  assert.equal(existsSync(agentDir), false)
  assert.equal(readFileSync(join(desktop, 'server.log'), 'utf8'), 'protected fixture\n')
})

test('server paths reject the default workspace and a workspace saved by an overridden desktop shell', t => {
  const root = mkdtempSync(join(tmpdir(), '.dsh-test-server-workspace-protection-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const shell = join(root, 'custom shell')
  const workspace = join(root, 'custom workspace')
  mkdirSync(shell)
  writeFileSync(join(shell, 'locations.json'), JSON.stringify({ dataDir: join(root, 'desktop-data'), workspace }))
  for (const path of [workspace, join(home, 'DS Bot')]) {
    const result = spawnSync(process.execPath, [CLI, 'install-agent', '--dry-run', '--home', join(path, 'server'),
      '--plist-dir', join(root, 'agents')], {
      cwd: root, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, DS_BOT_SHELL_DATA: shell }, encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /outside ~\/\.dsh and the desktop app data directory/)
    assert.equal(existsSync(path), false)
  }
})

test('LaunchAgent refuses case variants of protected roots on a case-insensitive volume', t => {
  const home = mkdtempSync(join(tmpdir(), '.dsh-test-server-case-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const dsh = join(home, '.dsh')
  const variant = join(home, '.DSH')
  const agents = join(home, 'agents')
  mkdirSync(join(dsh, 'existing'), { recursive: true })
  if (!existsSync(variant)) return t.skip('Temporary volume is case-sensitive')

  for (const path of [join(variant, 'existing'), join(variant, 'new', 'nested')]) {
    const result = spawnSync(process.execPath, [CLI, 'install-agent', '--dry-run', '--home', path, '--plist-dir', agents], {
      cwd: home, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, APPDATA: home, XDG_CONFIG_HOME: home }, encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /outside ~\/\.dsh and the desktop app data directory/)
  }
  assert.equal(existsSync(join(dsh, 'new')), false)
  assert.equal(existsSync(agents), false)
})
