import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'
import { parseOptions } from '../index.mjs'
import { writeServerPatches } from '../patches.mjs'
import { BROWSE, BUNDLES, loadServerProfile } from '../profile.mjs'

const temp = t => {
  const home = mkdtempSync(join(tmpdir(), '.dsh-test-server-config-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, XDG_CONFIG_HOME: home, DS_BOT_HOME: '', DS_BOT_SHELL_DATA: '', DS_BOT_WORKSPACE: '' }
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
  return home
}

test('CLI defaults to start and supports restricted mode', t => {
  const home = temp(t)
  const defaults = parseOptions([], { DSH_HOME: home })
  assert.deepEqual([defaults.command, defaults.home, defaults.unrestricted], ['start', home, true])
  assert.equal(parseOptions(['start', '--restricted'], { DSH_HOME: home }).unrestricted, false)
  assert.equal(parseOptions([], { DSH_HOME: home, DS_BOT_UNRESTRICTED: '0' }).unrestricted, false)
})

test('isolated profile composes onboarding, browse, permissions, and goal overlays', async t => {
  const home = temp(t)
  let profile = loadServerProfile(home)
  assert.equal(profile.dir, join(home, 'profiles', 'ds-bot-server'))
  assert.deepEqual(profile.layers.map(layer => layer.packageName), BUNDLES)
  const patch = join(profile.dir, 'cordis.patch.yml')
  writeFileSync(patch, '- id: bot\n  config:\n    browser: false\n    mainName: Test\n- id: web-search-auto\n  disabled: true\n')
  profile = loadServerProfile(home)
  const compose = async (unrestricted, browse) => {
    const { patchFiles } = await writeServerPatches(profile, { unrestricted, browse })
    const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches,
      ...patchFiles.map(file => load(readFileSync(file, 'utf8'), { schema: entryListSchema }))])
    return { ids: patchFiles.map(file => basename(file)), byId: id => entries.find(entry => entry.id === id), entries }
  }
  const full = await compose(true, true)
  assert.deepEqual(full.ids, ['app-onboarding.patch.yml', 'goal.patch.yml', 'search-selector.patch.yml', 'server-mode.patch.yml'])
  assert.deepEqual(full.byId('bot').config, {
    browser: false, mainName: 'Test', home: join(home, 'bot'), workspace: join(home, 'bot', 'workspace'), serverMode: true, unrestricted: true,
  })
  assert.equal(full.byId('permission').config.defaultPreset, 'danger-full-access')
  assert.equal(full.byId('permission').config.presets['workspace-write'].sandbox, 'workspace-write')
  assert.equal(full.byId('directory-picker').disabled, true)
  assert.equal(full.byId('directory-picker-browse').name, BROWSE)
  assert.equal(full.byId('ui-settings-models').config.credentialOnboarding, false)
  assert.equal(full.byId('web-runtime').config.printUrl, false)
  assert.notEqual(full.byId('web').config.searchProvider, 'auto')
  assert.doesNotMatch(JSON.stringify(full.entries.filter(entry => entry.name === '@deepseek-ai/dsh-agent-preset')), /dsh-(?:command|tool)-goal/)
  const restricted = await compose(false, false)
  assert.equal(restricted.byId('bot').config.unrestricted, false)
  assert.notEqual(restricted.byId('permission').config.defaultPreset, 'danger-full-access')
  assert.equal(restricted.byId('directory-picker').name, '@deepseek-ai/dsh-host-directory-picker-auto')
})

test('Office overlay uses the standalone runtime only when the payload is present', async t => {
  const home = temp(t)
  const profile = loadServerProfile(home)
  const runtimeDir = join(home, 'runtime')
  const source = join(runtimeDir, 'primary-runtime')
  const node = join(source, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  const options = { unrestricted: false, browse: false, runtimeDir }
  assert.equal((await writeServerPatches(profile, options)).officeNode, undefined)
  for (const path of [join(source, 'runtime.json'), node, join(runtimeDir, 'office-skills', 'office', 'SKILL.md')]) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '')
  }
  const { patchFiles, officeNode } = await writeServerPatches(profile, options)
  assert.equal(officeNode, node)
  const office = patchFiles.find(path => basename(path) === 'office.patch.yml')
  assert.ok(office)
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches,
    load(readFileSync(office, 'utf8'), { schema: entryListSchema })])
  assert.equal(entries.find(row => row.id === 'workspace-dependencies').config.source, source)
  assert.equal(entries.find(row => row.id === 'skill-office').config.assetRoot, join(runtimeDir, 'office-skills'))
})

const CLI = fileURLToPath(new URL('../index.mjs', import.meta.url))

test('startup rejects protected profile and overlay symlinks before writing', { skip: process.platform === 'win32' }, async t => {
  const userHome = temp(t)
  const dsh = join(userHome, '.dsh')
  const desktop = join(userHome, '.ds-bot')
  const fixture = 'protected fixture\n'
  for (const root of [dsh, desktop]) {
    mkdirSync(root)
    writeFileSync(join(root, 'fixture'), fixture)
  }
  const cases = [
    ['profiles directory', 'profiles', dsh],
    ['profile directory', 'profiles/ds-bot-server', desktop],
    ['profile node_modules', 'profiles/ds-bot-server/node_modules', dsh],
    ['home patch', 'cordis.patch.yml', join(dsh, 'fixture')],
    ...['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'cordis.yml'].map(name =>
      [name, `profiles/ds-bot-server/${name}`, join(dsh, 'fixture')]),
    ...['app-onboarding', 'goal', 'search-selector', 'office', 'server-mode'].map(name =>
      [`${name} overlay`, `profiles/${name}.patch.yml`, join(desktop, 'fixture')]),
  ]
  for (const [i, [label, relativePath, target]] of cases.entries()) {
    await t.test(label, () => {
      const home = join(userHome, `server-${i}`)
      const link = join(home, relativePath)
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(target, link)
      const result = spawnSync(process.execPath, [CLI, 'start', '--home', home, '--port', '0'], {
        cwd: userHome, env: { PATH: process.env.PATH, HOME: userHome, XDG_CONFIG_HOME: userHome }, encoding: 'utf8', timeout: 10000,
      })
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /outside ~\/\.dsh and the desktop app data directory/)
      assert.ok(lstatSync(link).isSymbolicLink())
      assert.deepEqual(readdirSync(dirname(link)), [basename(link)])
      for (const root of [dsh, desktop]) {
        assert.deepEqual(readdirSync(root), ['fixture'])
        assert.equal(readFileSync(join(root, 'fixture'), 'utf8'), fixture)
      }
    })
  }
})


test('startup rejects protected Bot data and workspace destinations before mounting the plugin', { skip: process.platform === 'win32' }, async t => {
  const userHome = temp(t)
  const protectedDir = join(userHome, 'desktop-data')
  const shell = join(userHome, 'desktop-shell')
  mkdirSync(protectedDir)
  mkdirSync(shell)
  writeFileSync(join(shell, 'locations.json'), JSON.stringify({ dataDir: protectedDir }))
  const fixture = 'protected fixture\n'
  writeFileSync(join(protectedDir, 'fixture'), fixture)
  const cases = [
    ['default Bot home', { link: 'bot' }],
    ['default workspace', { link: 'bot/workspace' }],
    ['nested workspace link', { link: 'bot/workspace/nested/link' }],
    ['linked state.json', { link: 'bot/state.json', file: true }],
    ['linked state.lock', { link: 'bot/state.lock', file: true }],
    ['unrelated server-home descendant', { link: 'other/nested/link' }],
    ['configured absolute Bot home', { config: { home: protectedDir } }],
    ['configured relative Bot home', { config: { home: '../desktop-data' } }],
    ['configured workspace from home patch', { config: { workspace: protectedDir }, homePatch: true }],
    ['Bot configured in a group', { config: { home: protectedDir }, group: true }],
    ['workspace environment override', { workspace: protectedDir }],
    ['nested link under an external Bot home', { config: { home: '../external-bot' }, external: true }],
  ]
  for (const [i, [label, scenario]] of cases.entries()) {
    await t.test(label, () => {
      const home = join(userHome, `server-${i}`)
      const profile = join(home, 'profiles', 'ds-bot-server')
      mkdirSync(home)
      if (scenario.link) {
        const link = join(home, scenario.link)
        mkdirSync(dirname(link), { recursive: true })
        symlinkSync(scenario.file ? join(protectedDir, 'fixture') : protectedDir, link)
      }
      if (scenario.external) {
        const dir = join(userHome, 'external-bot', 'workspace', 'nested')
        mkdirSync(dir, { recursive: true })
        symlinkSync(protectedDir, join(dir, 'link'))
      }
      if (scenario.config) {
        const dir = scenario.homePatch ? home : profile
        mkdirSync(dir, { recursive: true })
        const patch = scenario.group
          ? [{ insert: [{ id: 'test-group', group: true, config: [{ id: 'test-bot', name: 'ds-bot', config: scenario.config }] }] }]
          : [{ id: 'bot', config: scenario.config }]
        writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify(patch))
      }
      const protection = i % 2 ? { DS_BOT_SHELL_DATA: shell } : { DS_BOT_HOME: protectedDir }
      const result = spawnSync(process.execPath, [CLI, 'start', '--home', home, '--port', '0'], {
        cwd: userHome, env: { PATH: process.env.PATH, HOME: userHome, XDG_CONFIG_HOME: userHome,
          DS_BOT_OFFICE_NODE: '', DS_BOT_WORKSPACE: scenario.workspace ?? '', ...protection },
        encoding: 'utf8', timeout: 10000,
      })
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /outside ~\/\.dsh and the desktop app data directory/)
      assert.equal(existsSync(join(profile, 'cordis.yml')), false)
      assert.equal(existsSync(join(home, 'profiles', 'server-mode.patch.yml')), false)
      if (scenario.link) assert.equal(existsSync(profile), false)
      assert.deepEqual(readdirSync(protectedDir), ['fixture'])
      assert.equal(readFileSync(join(protectedDir, 'fixture'), 'utf8'), fixture)
    })
  }
})
