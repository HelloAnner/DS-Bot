import assert from 'node:assert/strict'
import { fork, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const pathGuard = new URL('../launchd.mjs', import.meta.url).href

const cli = fileURLToPath(new URL('../index.mjs', import.meta.url))
const put = (root, path, content) => {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
}
const read = (root, path) => readFileSync(join(root, path), 'utf8')
const json = (root, path) => JSON.parse(read(root, path))
const secret = 'SYNTHETIC-IMPORT-TEST-VALUE'
const team = (name = 'Imported Chief') => ({
  version: 1, mainBotIds: ['chief'], bots: { chief: { id: 'chief', name, role: 'Chief', instructions: '', sessionId: 'private', segments: [{ sessionId: 'old' }] } },
  rooms: { room: { id: 'room', name: 'Imported Room', members: ['chief'], sessions: { chief: 'member' }, segments: { chief: [{ sessionId: 'missing' }] } } },
  workspaceId: 'old-workspace', agents: { old: {} },
})

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), '.dsh-test-server-import-')))
  t.after(() => { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false) })
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, APPDATA: root, XDG_CONFIG_HOME: root, DSH_TELEMETRY_DISABLED: '1' }
  const run = (args, extra) => {
    const result = spawnSync(process.execPath, [cli, 'import', ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 })
    assert.equal(`${result.stdout ?? ''}${result.stderr ?? ''}`.includes(secret), false)
    assert.ifError(result.error)
    return result
  }
  return { root, env, run }
}

function snapshot(root, path = '') {
  const full = join(root, path)
  const stat = lstatSync(full, { bigint: true })
  // Reads can change atime. Check permissions, mtime, ctime, and contents instead.
  const metadata = [path, stat.mode, stat.ino, stat.mtimeNs, stat.ctimeNs]
  if (stat.isDirectory()) return [metadata, ...readdirSync(full).sort().flatMap(name => snapshot(root, join(path, name)))]
  return [[...metadata, stat.isSymbolicLink() ? readlinkSync(full) : readFileSync(full)]]
}

function clean(target) {
  if (existsSync(target)) assert.deepEqual(readdirSync(target).filter(name => name.startsWith('.import') || name.startsWith('.server.lock')), [])
}

test('import discovers override, saved desktop, default desktop, then DSH; explicit source wins', t => {
  const { root, run } = fixture(t)
  const shell = join(root, 'shell')
  const saved = join(root, 'custom')
  const override = join(root, 'override')
  for (const [dir, name] of [[saved, 'Saved'], [join(root, '.dsh'), 'DSH'], [override, 'Override'], [join(root, '.ds-bot'), 'Desktop']]) {
    put(dir, 'bot/state.json', team(name))
  }
  put(shell, 'locations.json', { dataDir: saved })
  for (const [i, [flags, env, expected]] of [
    [[], { DS_BOT_SHELL_DATA: shell, DS_BOT_HOME: override }, 'Override'],
    [[], { DS_BOT_SHELL_DATA: shell }, 'Saved'],
    [[], {}, 'Desktop'],
    [['--from', join(root, '.dsh')], { DS_BOT_HOME: override }, 'DSH'],
  ].entries()) {
    const to = join(root, `server-${i}`)
    const result = run(['--home', to, ...flags], env)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(json(to, 'bot/state.json').bots.chief.name, expected)
    clean(to)
  }
  put(join(root, '.ds-bot'), 'bot/state.json', { bots: {} })
  const result = run([], { DSH_HOME: join(root, '.dsh') })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(json(join(root, '.ds-bot-server'), 'bot/state.json').bots.chief.name, 'DSH')
})

test('desktop workspace import keeps saved locations and both workspace trees unchanged', t => {
  const { root, run } = fixture(t)
  const shell = join(root, 'override-shell')
  const from = join(root, 'desktop-data')
  const workspace = join(root, 'desktop-work')
  put(shell, 'locations.json', { dataDir: from, workspace })
  put(from, 'bot/state.json', team())
  put(from, 'bot/workspace/embedded.txt', 'embedded work')
  put(workspace, 'separate.txt', 'desktop work')
  put(from, 'bot/workspace/shared.txt', 'embedded version')
  put(workspace, 'shared.txt', 'desktop version')
  put(from, 'bot/workspace/mixed/embedded.txt', 'embedded nested file')
  put(workspace, 'mixed/desktop.txt', 'desktop nested file')
  put(from, 'bot/workspace/shape/nested.txt', 'embedded directory')
  put(workspace, 'shape', 'desktop file')
  put(join(root, 'DS Bot'), 'unpaired.txt', 'not part of this team')
  const sourcePaths = [shell, from, workspace]
  const before = sourcePaths.map(path => snapshot(path))
  for (const [name, flags] of [['discovered', []], ['explicit', ['--from', from]]]) {
    const to = join(root, name)
    const result = run(['--home', to, ...flags], { DS_BOT_SHELL_DATA: shell })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(read(to, 'bot/workspace/embedded.txt'), 'embedded work')
    assert.equal(read(to, 'bot/workspace/separate.txt'), 'desktop work')
    assert.equal(read(to, 'bot/workspace/shared.txt'), 'desktop version')
    assert.equal(read(to, 'bot/workspace/mixed/embedded.txt'), 'embedded nested file')
    assert.equal(read(to, 'bot/workspace/mixed/desktop.txt'), 'desktop nested file')
    assert.equal(read(to, 'bot/workspace/shape'), 'desktop file')
    assert.equal(existsSync(join(to, 'bot/workspace/unpaired.txt')), false)
    assert.deepEqual(sourcePaths.map(path => snapshot(path)), before)
    clean(to)
  }
})

test('desktop default workspace is imported only for the default desktop team', t => {
  const { root, run } = fixture(t)
  put(join(root, 'DS Bot'), 'default.txt', 'default desktop work')
  put(join(root, '.dsh'), 'bot/state.json', team('DSH team'))
  const dsh = join(root, 'dsh-server')
  const fromDsh = run(['--home', dsh])
  assert.equal(fromDsh.status, 0, fromDsh.stderr)
  assert.equal(existsSync(join(dsh, 'bot/workspace/default.txt')), false)
  put(join(root, '.ds-bot'), 'bot/state.json', team('Desktop team'))
  const desktop = join(root, 'desktop-server')
  const fromDesktop = run(['--home', desktop])
  assert.equal(fromDesktop.status, 0, fromDesktop.stderr)
  assert.equal(read(desktop, 'bot/workspace/default.txt'), 'default desktop work')
})

test('full staged import preserves source bytes and mtimes and boots the copied team', { timeout: 45000 }, async t => {
  const { root, env, run } = fixture(t)
  const from = join(root, '.ds-bot')
  const to = join(root, 'server')
  put(from, 'bot/state.json', team())
  put(from, 'bot/inflight.json', {})
  put(from, 'bot/state.lock', { host: hostname(), pid: process.pid })
  const stale = new Date(Date.now() - 120000)
  utimesSync(join(from, 'bot', 'state.lock'), stale, stale)
  put(from, 'bot/workspace/main.txt', 'original work')
  put(from, 'bot/workspace/node_modules/pkg/index.js', 'regenerable')
  put(from, 'bot/notes.txt', 'team notes')
  for (const path of ['.launch-url', 'bot/.launch-url', 'bot/workspace/.launch-url', 'attachments/.launch-url']) put(from, path, secret)
  put(from, 'attachments/a.txt', 'attachment')
  for (const id of ['chief', 'private', 'old', 'room', 'member', 'unreferenced']) put(from, `sessions/group/${id}/fixture`, id)
  put(from, '.credentials.yaml', `version: 1\nrefs: {}\nrecords: {}\n# ${secret}\n`)
  put(from, '.env', `IMPORT_FIXTURE=${secret}\n`)
  put(from, 'profiles/ds-bot/cordis.patch.yml', [{ id: 'llm-deepseek', config: {} }, { id: 'not-a-model' }])
  put(from, 'profiles/default/cordis.patch.yml', [{ id: 'llm-pi-ai' }])
  put(to, 'profiles/ds-bot-server/cordis.patch.yml', [{ id: 'bot', config: { browser: false } }])
  put(to, '.credentials.yaml', 'version: 1\nrecords:\n  client-connection/test: {}\n')
  put(to, 'bot/workspace/main.txt', 'keep target file')
  const before = snapshot(from)
  const hook = join(root, 'pause-publish.mjs')
  put(root, 'pause-publish.mjs', `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const mkdir = fs.promises.mkdir;
    fs.promises.mkdir = async (path, options) => {
      if (path === ${JSON.stringify(join(to, 'sessions'))}) {
        await new Promise(resolve => {
          process.once('message', resolve);
          process.send('before publication');
        });
      }
      return mkdir(path, options);
    };
    syncBuiltinESMExports();`)
  const importing = fork(cli, ['import', '--from', from, '--home', to], {
    cwd: root, env, execArgv: ['--import', hook], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  importing.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  importing.stderr.resume()
  const imported = once(importing, 'close')
  try {
    const [phase] = await once(importing, 'message', { signal: AbortSignal.timeout(10000) })
    assert.equal(phase, 'before publication')
    assert.equal(existsSync(join(to, 'sessions')), false)
    const beforeStart = snapshot(to).slice(1)
    const duplicateImport = run(['--from', from, '--home', to])
    assert.equal(duplicateImport.status, 1)
    assert.match(duplicateImport.stderr, /import is already in progress/)
    let startHome = to
    if (process.platform !== 'win32') {
      startHome = join(root, 'server-alias')
      symlinkSync(to, startHome)
    }
    const result = spawnSync(process.execPath, [cli, 'start', '--home', startHome, '--port', '0'], {
      cwd: root, env: { ...env, DS_BOT_SUPERVISED: '1' }, encoding: 'utf8', timeout: 5000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /import is already in progress/)
    // The root directory timestamps can change when the startup lock is acquired and released.
    assert.deepEqual(snapshot(to).slice(1), beforeStart)
    importing.send('publish')
    assert.deepEqual(await imported, [0, null])
    assert.match(output, /Imported 1 bot\(s\), 1 room\(s\), 5 session\(s\) \(1 missing\)/)
    assert.equal(output.includes(secret), false)
  } finally {
    if (importing.exitCode === null && importing.signalCode === null) importing.kill('SIGKILL')
    await imported
  }
  const state = json(to, 'bot/state.json')
  assert.equal(state.workspaceId, undefined)
  assert.deepEqual(state.agents, {})
  assert.equal(state.rooms.room.name, 'Imported Room')
  for (const id of ['chief', 'private', 'old', 'room', 'member']) assert.equal(read(to, `sessions/group/${id}/fixture`), id)
  for (const path of ['sessions/group/unreferenced', 'bot/state.lock', 'bot/inflight.json', '.launch-url', 'bot/.launch-url', 'bot/workspace/.launch-url', 'attachments/.launch-url']) assert.equal(existsSync(join(to, path)), false)
  assert.equal(read(to, 'attachments/a.txt'), 'attachment')
  assert.equal(read(to, 'bot/notes.txt'), 'team notes')
  assert.equal(read(to, 'bot/workspace/main.txt'), 'keep target file')
  assert.equal(read(to, 'bot/workspace/node_modules/pkg/index.js'), 'regenerable')
  for (const path of ['.credentials.yaml', '.env']) {
    assert.equal(read(to, path) === read(from, path), true)
    if (process.platform !== 'win32') assert.equal(lstatSync(join(to, path)).mode & 0o777, 0o600)
  }
  assert.deepEqual(load(read(to, 'profiles/ds-bot-server/cordis.patch.yml')).map(row => row.id), ['bot', 'llm-deepseek'])
  const { at, ...summary } = json(to, 'bot/imported.json')
  assert.ok(Number.isFinite(Date.parse(at)))
  assert.deepEqual(summary, { from, bots: 1, rooms: 1, sessions: 5, missingSessions: ['missing'], keys: ['.credentials.yaml', '.env'], keptKeys: [], modelSettings: 'ds-bot' })
  assert.equal(read(to, 'bot/imported.json').includes(secret), false)
  assert.deepEqual(snapshot(from), before)
  clean(to)

  const dead = spawnSync(process.execPath, ['-e', ''], { cwd: root, env })
  assert.equal(dead.status, 0)
  assert.throws(() => process.kill(dead.pid, 0), { code: 'ESRCH' })
  put(to, '.server.lock/00000000-0000-4000-8000-000000000000.json', { pid: dead.pid })
  const child = fork(cli, ['start', '--home', to, '--port', '0'], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  child.stderr.resume()
  const exited = once(child, 'exit')
  try {
    const [launch] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Imported server exited before readiness') })])
    const blocked = run(['--from', from, '--home', to])
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /server is already running/)
    const duplicateStart = spawnSync(process.execPath, [cli, 'start', '--home', to, '--port', '0'], {
      cwd: root, env, encoding: 'utf8', timeout: 5000,
    })
    assert.ifError(duplicateStart.error)
    assert.equal(duplicateStart.status, 1)
    assert.match(duplicateStart.stderr, /server is already running/)
    const login = await fetch(launch.url, { redirect: 'manual' })
    assert.equal(login.status, 303)
    const cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
    await login.body?.cancel()
    const response = await fetch(new URL('/api/bot', launch.url), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint: 'state', payload: {} }),
    })
    assert.equal(response.status, 200)
    const roster = await response.json()
    assert.equal(roster.ok, true)
    assert.ok(roster.value.bots.some(bot => bot.name === 'Imported Chief'))
    assert.ok(child.kill('SIGTERM'))
    assert.deepEqual(await exited, [0, null])
    t.diagnostic('Imported server: POST /api/bot state 200, imported Bot visible, SIGTERM exit 0')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
  clean(to)
  assert.deepEqual(snapshot(from), before)
})

test('import refuses live teams, an existing target team, and overlapping directories', t => {
  const { root, run } = fixture(t)
  const from = join(root, 'source')
  const to = join(root, 'server')
  put(from, 'bot/state.json', team())
  for (const holder of [{ host: hostname(), pid: process.pid }, { host: 'another-host', pid: 2147483647 }]) {
    put(from, 'bot/state.lock', holder)
    const before = snapshot(from)
    const result = run(['--from', from, '--home', to])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Quit DS Bot or DSH/)
    assert.deepEqual(snapshot(from), before)
    assert.equal(existsSync(to), false)
  }
  rmSync(join(from, 'bot/state.lock'))
  put(to, 'bot/state.json', team('Unchanged'))
  assert.match(run(['--from', from, '--home', to]).stderr, /already has a Bot team/)
  assert.equal(json(to, 'bot/state.json').bots.chief.name, 'Unchanged')
  for (const destination of [from, join(from, 'nested'), root]) {
    const result = run(['--from', from, '--home', destination])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /must not overlap/)
  }
  assert.match(run(['--from', join(root, 'empty'), '--home', to]).stderr, /No Bot team found/)
  clean(to)
})

test('workspace options skip regenerable files and never recreate source symlinks', { skip: process.platform === 'win32' }, t => {
  const { root, env, run } = fixture(t)
  const from = join(root, '.dsh')
  const work = join(from, 'bot/workspace')
  put(from, 'bot/state.json', team())
  put(work, 'docs/readme', 'work')
  put(work, 'docs/.venv/scratch', 'regenerable')
  put(from, '.env', `IMPORT_FIXTURE=${secret}\n`)
  put(from, 'profiles/ds-bot/cordis.patch.yml', [{ id: 'llm-deepseek' }])
  put(from, 'profiles/default/cordis.patch.yml', [{ id: 'llm-pi-ai' }])
  symlinkSync('docs', join(work, 'internal'))
  symlinkSync('nowhere', join(work, 'dangling'))
  symlinkSync('.', join(work, 'cycle'))
  symlinkSync(from, join(work, 'external'))
  const before = snapshot(from)
  for (const [flag, dir] of [['--skip-work', 'skip'], ['--leave-regenerable', 'leave']]) {
    const to = join(root, dir)
    put(to, '.env', 'EXISTING=keep\n')
    const result = run(['--from', from, '--home', to, '--profile', 'default', flag])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(read(to, '.env'), 'EXISTING=keep\n')
    assert.deepEqual(json(to, 'bot/imported.json').keptKeys, ['.env'])
    assert.equal(json(to, 'bot/imported.json').modelSettings, 'default')
    const out = join(to, 'bot/workspace')
    if (dir === 'skip') assert.equal(existsSync(out), false)
    else {
      assert.equal(read(out, 'docs/readme'), 'work')
      assert.equal(read(out, 'internal/readme'), 'work')
      assert.equal(lstatSync(join(out, 'internal')).isSymbolicLink(), false)
      assert.deepEqual(readdirSync(out).sort(), ['docs', 'internal'])
      for (const path of ['docs/.venv', 'internal/.venv']) assert.equal(existsSync(join(out, path)), false)
    }
    const guard = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { assertServerTrees } from ${JSON.stringify(pathGuard)}; assertServerTrees(process.argv[1])`, to], { cwd: root, env, encoding: 'utf8' })
    assert.equal(guard.status, 0, guard.stderr)
    clean(to)
  }
  assert.deepEqual(snapshot(from), before)
})


test('failed staging cleans up without printing YAML content or changing the source', t => {
  const { root, run } = fixture(t)
  const from = join(root, 'source')
  const to = join(root, 'server')
  put(from, 'bot/state.json', team())
  put(from, 'profiles/custom/cordis.patch.yml', [{ id: 'llm-deepseek' }])
  put(to, 'profiles/ds-bot-server/cordis.patch.yml', `- bad: [${secret}\n`)
  const before = snapshot(from)
  const target = snapshot(to).filter(([path]) => path !== '')
  const failed = run(['--from', from, '--home', to, '--profile', 'custom'])
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /destination profile patch as a YAML row list/)
  assert.deepEqual(snapshot(from), before)
  assert.deepEqual(snapshot(to).filter(([path]) => path !== ''), target)
  clean(to)
})


test('import checks and uses the configured Bot home and workspace', t => {
  const { root, run } = fixture(t)
  const from = join(root, 'source')
  const to = join(root, 'server')
  put(from, 'bot/state.json', team())
  put(from, 'bot/workspace/file', 'imported work')
  put(to, 'profiles/ds-bot-server/cordis.patch.yml', [{ id: 'bot', config: { home: 'custom-bot' } }])
  put(to, 'custom-bot/state.json', team('Keep this team'))
  const before = snapshot(join(to, 'custom-bot'))
  const flags = ['--from', from, '--home', to]
  const rejected = run(flags)
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /already has a Bot team/)
  assert.deepEqual(snapshot(join(to, 'custom-bot')), before)
  assert.equal(existsSync(join(to, 'bot')), false)
  clean(to)
  put(to, 'custom-bot/state.json', { bots: {} })
  put(to, 'custom-bot/state.lock', { host: hostname(), pid: process.pid })
  assert.match(run(flags).stderr, /destination Bot team may be running/)
  clean(to)
  rmSync(join(to, 'custom-bot/state.lock'))
  const dead = spawnSync(process.execPath, ['-e', ''], { cwd: root })
  assert.equal(dead.status, 0)
  assert.throws(() => process.kill(dead.pid, 0), { code: 'ESRCH' })
  put(to, '.import.lock/00000000-0000-4000-8000-000000000000.json', { pid: dead.pid })
  put(to, '.env', 'DS_BOT_WORKSPACE=custom-work\n')
  const imported = run(flags)
  assert.equal(imported.status, 0, imported.stderr)
  assert.equal(json(to, 'custom-bot/state.json').bots.chief.name, 'Imported Chief')
  assert.equal(read(to, 'custom-work/file'), 'imported work')
  assert.equal(existsSync(join(to, 'bot')), false)
  clean(to)
})

test('attachment conflict is rejected before publishing any sessions', t => {
  const { root, run } = fixture(t)
  const from = join(root, 'source')
  const to = join(root, 'server')
  put(from, 'bot/state.json', team())
  put(from, 'sessions/group/chief/fixture', 'session')
  put(from, 'attachments/photo', 'photo')
  put(to, 'attachments', 'blocking file')
  const before = snapshot(from)
  const result = run(['--from', from, '--home', to])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /destination conflict.*attachments/)
  assert.deepEqual(readdirSync(to), ['attachments'])
  assert.equal(read(to, 'attachments'), 'blocking file')
  assert.deepEqual(snapshot(from), before)
  clean(to)
})

test('publish failure rolls back new paths and restores replaced files', t => {
  const { root, run } = fixture(t)
  const from = join(root, 'source')
  const to = join(root, 'server')
  put(from, 'bot/state.json', team())
  put(from, 'sessions/group/chief/fixture', 'session')
  put(from, 'attachments/photo', 'photo')
  put(from, '.credentials.yaml', 'version: 1\nrecords: {}\n')
  put(from, 'profiles/ds-bot/cordis.patch.yml', [{ id: 'llm-deepseek' }])
  put(to, 'bot/state.json', { bots: {} })
  put(to, 'attachments/keep', 'pre-existing attachment')
  put(to, '.credentials.yaml', 'version: 1\nrecords:\n  client-connection/test: {}\n')
  put(to, 'profiles/ds-bot-server/cordis.patch.yml', [{ id: 'bot', config: { browser: false } }])
  const before = snapshot(from)
  const existing = snapshot(to).filter(entry => entry.length === 6).map(([path, mode, ino, mtime, , body]) => [path, mode, ino, mtime, body])
  const hook = join(root, 'fail-publish.mjs')
  put(root, 'fail-publish.mjs', `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const original = fs.promises.link;
    fs.promises.link = (source, target) => {
      if (target === ${JSON.stringify(join(to, 'bot/state.json'))}) throw new Error('Injected final publish failure');
      return original(source, target);
    };
    syncBuiltinESMExports();`)
  const result = run(['--from', from, '--home', to], { NODE_OPTIONS: `--import=${hook}` })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Injected final publish failure/)
  assert.deepEqual(snapshot(to).filter(entry => entry.length === 6).map(([path, mode, ino, mtime, , body]) => [path, mode, ino, mtime, body]), existing)
  assert.equal(existsSync(join(to, 'sessions')), false)
  assert.deepEqual(snapshot(from), before)
  clean(to)
})
