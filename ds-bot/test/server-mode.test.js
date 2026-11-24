import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { gateScope } from '../src/host/browser/gate.js'
import { fakeContext } from './fake-ctx.js'

function start(t, config, services = {}, seed = true) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-server-mode-'))
  t.mock.property(process, 'env', { ...process.env, DSH_HOME: home,
    DS_BOT_APP: '', DS_BOT_SERVER: '', DS_BOT_UNRESTRICTED: '', DS_BOT_SUPERVISED: '' })
  const botHome = join(home, 'bot')
  if (seed) writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['chief'], bots: { chief: { id: 'chief', name: 'Chief', instructions: '' } },
  }))
  const ctx = fakeContext({ services })
  const workspace = { id: 'w', path: join(home, 'workspace') }
  let count = 0
  Object.assign(ctx, {
    workspaceRegistry: { get: id => id === 'w' ? workspace : undefined, resolveByPath: async () => undefined,
      create: async () => workspace, archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: `new-${++count}` }),
      resolveAgent: async id => ({ agent: { ...ctx.scopeAgent(id), followup: () => {} } }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  if (config.env) Object.assign(process.env, config.env)
  const rt = createRuntime(ctx, { home: seed ? home : botHome, workspace: workspace.path, ...config })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return { rt, ctx, home }
}

test('server state and info describe the running host; unmanaged restart is refused', async t => {
  const { rt, home } = start(t, { serverMode: true, unrestricted: true }, {}, false)
  const { value } = await rt.channelCall('state', {})
  assert.equal(value.browser, true)
  assert.equal(value.browserMode, 'server')
  assert.deepEqual(value.server, { enabled: true, hostname: hostname(), platform: process.platform,
    dshHome: home, botHome: join(home, 'bot'), unrestricted: true, startedAt: value.server.startedAt, canRestart: false })
  const info = await rt.channelCall('server-info')
  assert.equal(info.ok, true)
  assert.equal(info.value.teamWorkspace, join(home, 'workspace'))
  assert.ok(info.value.uptimeMs >= 0)
  assert.equal(info.value.startedAt, value.server.startedAt)
  assert.equal((await rt.channelCall('server-restart')).error.code, 'bot/refused')
  assert.deepEqual((await rt.channelCall('browser-tab-list', { botId: value.mainBotId })).value, { tabs: [], activeTabId: null })
  assert.equal((await rt.channelCall('browser-tab-list', { botId: 'no-such-bot' })).error.code, 'bot/not-found')
})

test('a supervised server acknowledges restart before sending SIGTERM only once', async t => {
  const { rt } = start(t, { env: { DS_BOT_SERVER: '1', DS_BOT_UNRESTRICTED: '1', DS_BOT_SUPERVISED: '1' }, browser: false })
  const signalled = new Promise(resolve => t.mock.method(process, 'kill', (...args) => resolve(args)))
  const info = (await rt.channelCall('server-info')).value
  assert.equal(info.canRestart, true)
  assert.equal(info.unrestricted, true)
  assert.equal(rt.browserMode, 'none')
  assert.deepEqual(await rt.channelCall('server-restart'), { ok: true, value: { restarting: true } })
  assert.deepEqual(await rt.channelCall('server-restart'), { ok: true, value: { restarting: true } })
  assert.equal(process.kill.mock.callCount(), 0)
  const keepAlive = setTimeout(() => {}, 3000)
  try { assert.deepEqual(await signalled, [process.pid, 'SIGTERM']) } finally { clearTimeout(keepAlive) }
  assert.equal(process.kill.mock.callCount(), 1)
})

test('desktop mode retains Electron and accepts a separately registered server restart hook', async t => {
  const signal = new AbortController()
  const restarted = once(signal.signal, 'abort')
  const { rt } = start(t, { serverMode: true, env: { DS_BOT_APP: '1' }, serverRestart: () => signal.abort() })
  assert.equal(rt.browserMode, 'electron')
  assert.equal((await rt.channelCall('server-info')).value.canRestart, true)
  assert.equal((await rt.channelCall('browser-tab-list')).error.code, 'bot/browser-off')
  const keepAlive = setTimeout(() => {}, 3000)
  try {
    assert.equal((await rt.channelCall('server-restart')).ok, true)
    await restarted
  } finally { clearTimeout(keepAlive) }
})

test('unrestricted defaults apply to new Bots and groups, not adopted records', async t => {
  const writes = new Map()
  const permissionPresets = {
    catalog: () => ({ options: [{ value: 'workspace-write' }, { value: 'danger-full-access' }], defaultPreset: 'workspace-write' }),
    set: (session, name) => writes.set(session.id, name),
  }
  const { rt } = start(t, { unrestricted: true }, { permissionPresets })
  await rt.load()
  const chief = rt.botOf('chief')
  assert.equal(chief.permission, undefined)
  const bot = await rt.createBot({ name: 'Writer', pickModel: true })
  const room = await rt.createRoom({ name: 'Desk', members: [chief.id, bot.id] })
  const saved = JSON.parse(readFileSync(rt.statePath, 'utf8'))
  assert.equal(saved.bots[chief.id].permission, undefined)
  for (const entry of [saved.bots[bot.id], saved.rooms[room.id]]) {
    assert.equal(entry.permission, 'danger-full-access')
    assert.equal(writes.get(entry.id), 'danger-full-access')
  }
})

test('non-server defaults and an unavailable full-access preset leave records unchanged', async t => {
  const { rt } = start(t, { unrestricted: true }, { permissionPresets: {
    catalog: () => ({ options: [{ value: 'workspace-write' }], defaultPreset: 'workspace-write' }),
  } })
  assert.equal(rt.browserMode, 'none')
  assert.deepEqual((await rt.channelCall('server-info')).value, { enabled: false })
  const bot = await rt.createBot({ name: 'Writer', pickModel: true })
  assert.equal(bot.permission, undefined)
})

for (const unrestricted of [false, true]) {
  test(`folder and browser approvals with unrestricted=${unrestricted}`, async t => {
    let action = { kind: 'post', host: 'example.test', label: 'Publish' }
    const browserPluginApi = { tools: [{ name: 'test_post', needsBrowser: false, async execute() {
      await gateScope.getStore()(action)
      return 'published'
    } }] }
    let approvals = 0
    const { rt, home } = start(t, { unrestricted, browserPluginApi }, {
      approval: { request: async () => { ++approvals; return 'allowed-once' } },
    })
    await rt.load()
    const exec = { name: 'test_post', agent: { id: 'chief', session: { header: { id: 'chief' } } } }
    const folder = { path: home, botId: 'chief', who: { en: 'Chief', zh: 'Chief' } }
    const post = rt.teamTools.find(tool => tool.name === 'test_post')
    await rt.approveFolder(exec, folder)
    await post.execute({}, exec)
    assert.equal(approvals, unrestricted ? 0 : 2)
    rt.botOf('chief').permission = 'workspace-write'
    await rt.approveFolder(exec, folder)
    await post.execute({}, exec)
    assert.equal(approvals, unrestricted ? 2 : 4)
    action = { ...action, kind: 'payment' }
    await assert.rejects(post.execute({}, exec), /looks like a payment/)
  })
}

test('computer preview, takeover, stop, and handoff work without an Electron window', async t => {
  const { ctx, rt } = start(t, { serverMode: true }, { attachments: {
    readFileStream: async function* () { yield Buffer.from('shot') },
  } })
  await rt.load()
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  await track({ name: 'cua', arguments: { method: 'screenshot' }, agent: { id: 'chief' }, callId: 'one' }, async () => ({
    value: {}, content: [{ type: 'image', attachment: { id: 'shot', mediaType: 'image/jpeg' } }],
  }))
  assert.equal(rt.computerLive().bots.chief.lastShot.attachmentId, 'shot')
  assert.deepEqual((await rt.channelCall('computer-shot', { attachmentId: 'shot' })).value, { dataUrl: 'data:image/jpeg;base64,c2hvdA==' })
  assert.equal((await rt.channelCall('computer-shot', { attachmentId: 'unknown' })).value, null)
  rt.stopChat = t.mock.fn(async () => {})
  assert.equal((await rt.channelCall('computer-takeover', { botId: 'chief' })).value, true)
  assert.equal(rt.computerLive().holds.chief.by, 'user')
  assert.equal((await rt.channelCall('computer-stop', { botId: 'chief' })).value, true)
  assert.equal(rt.stopChat.mock.callCount(), 1)
  assert.deepEqual(await rt.channelCall('computer-handback', { botId: 'chief' }), { ok: true, value: true })
  assert.equal(rt.computerLive().holds.chief, undefined)
})

for (const restricted of ['auto', 'workspace-write']) {
  test(`unrestricted approvals honor a live ${restricted} caller and restricted destinations`, async t => {
    const full = 'danger-full-access'
    const current = new Map([['chief', full], ['destination', full]])
    const modes = new Map()
    const approval = t.mock.fn(async () => 'rejected')
    const browserPluginApi = { tools: [{ name: 'test_post', needsBrowser: false, async execute() {
      await gateScope.getStore()({ kind: 'post', host: 'example.test', label: 'Publish' })
      return 'published'
    } }] }
    const { rt, home } = start(t, { serverMode: true, unrestricted: true, browserPluginApi }, {
      permissionPresets: { current: session => current.get(session.id) },
      sandboxPolicy: { resolve: ({ session } = {}) => ({ mode: modes.get(session?.id) ?? full }) },
      approval: { request: approval },
    })
    await rt.load()
    rt.botOf('chief').permission = full
    const exec = { name: 'test_post', agent: { id: 'chief', session: { id: 'chief' } } }
    const folder = { path: home, places: [{ sessionId: 'destination', preset: full }], who: { en: 'Chief', zh: 'Chief' } }
    const post = rt.teamTools.find(tool => tool.name === 'test_post')
    await rt.approveFolder(exec, folder)
    assert.equal(await post.execute({}, exec), 'published')
    assert.equal(approval.mock.callCount(), 0)

    // Either live service can report a restriction independently of the stored preset.
    if (restricted === 'auto') current.set('chief', restricted)
    else modes.set('chief', restricted)
    await assert.rejects(rt.approveFolder(exec, folder), /was not allowed/)
    await assert.rejects(post.execute({}, exec), /did not approve/)
    assert.equal(approval.mock.callCount(), 2)

    current.set('chief', full)
    modes.delete('chief')
    await assert.rejects(rt.approveFolder(exec, { ...folder, places: [{ preset: restricted }] }), /was not allowed/)
    current.set('destination', restricted)
    await assert.rejects(rt.approveFolder(exec, folder), /was not allowed/)
    assert.equal(approval.mock.callCount(), 4)
  })
}
