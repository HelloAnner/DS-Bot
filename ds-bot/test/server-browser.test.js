import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { install as installBrowser, NO_PAGE } from '../src/host/browser.js'
import { createServerBrowser } from '../src/host/server-browser.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

function fakeBrowser() {
  const calls = []
  const browser = new EventEmitter()
  browser.close = async () => { browser.emit('disconnected') }
  browser.newContext = async () => {
    calls.push('context')
    const context = Object.assign(new EventEmitter(), { route: async () => {}, close: async () => { calls.push('drop') } })
    context.newPage = async () => {
      const page = new EventEmitter()
      let viewport = { width: 1280, height: 720 }
      let history = ['about:blank']
      let index = 0
      page.history = () => ({ entries: history, currentIndex: index })
      page.url = () => history[index]
      page.title = async () => new URL(page.url()).pathname
      page.goto = async url => { history = [...history.slice(0, index + 1), url]; index++ }
      page.goBack = async () => { index-- }
      page.goForward = async () => { index++ }
      page.reload = async () => { calls.push('reload') }
      page.close = async () => { page.emit('close') }
      page.evaluate = async () => ({ title: await page.title(), url: page.url(), text: '# Report\n\nOpen [#1]', items: [{ role: 'link', name: 'Open' }], format: 'markdown' })
      page.viewportSize = () => viewport
      page.setViewportSize = async size => { viewport = size }
      page.screenshot = async () => Buffer.from(`${page.url()} at ${viewport.width}x${viewport.height}`)
      page.mouse = Object.fromEntries(['click', 'move', 'wheel'].map(key => [key, async (...args) => { calls.push([key, ...args]) }]))
      page.keyboard = Object.fromEntries(['down', 'up', 'insertText'].map(key => [key, async (...args) => { calls.push([key, ...args]) }]))
      return page
    }
    context.newCDPSession = async page => ({ send: async command => command === 'Page.getNavigationHistory' ? page.history() : calls.push(command) })
    return context
  }
  return { browser, calls }
}

test('server browser lazily launches, isolates tabs, and handles navigation, frames and input', async t => {
  const { browser, calls } = fakeBrowser()
  const launch = t.mock.fn(async () => browser)
  const manager = createServerBrowser({ launch })
  t.after(() => manager.dispose())
  const call = (name, body = {}, bot = 'one') => manager.call(`browser-tab-${name}`, bot, body)
  assert.deepEqual(await call('list'), { tabs: [], activeTabId: null })
  await assert.rejects(call('open', { url: 'file:///etc/hosts' }), /HTTP or HTTPS/)
  await assert.rejects(call('open', { url: 'http://169.254.169.254/' }), { code: 'bot/forbidden' })
  assert.equal(launch.mock.callCount(), 0)
  const { tabId } = await call('open')
  assert.equal((await call('frame', { tabId })).image, null)
  const first = await call('nav', { tabId, url: 'https://example.test/first' })
  assert.equal(first.title, '/first')
  assert.equal(first.loading, false)
  await call('nav', { tabId, url: 'https://example.test/second' })
  const back = await call('cmd', { tabId, command: 'back' })
  assert.equal(back.url, first.url)
  assert.equal(back.canGoForward, true)
  assert.equal((await call('cmd', { tabId, command: 'forward' })).title, '/second')
  await call('cmd', { tabId, command: 'reload' })
  await call('cmd', { tabId, command: 'stop' })
  const frame = await call('frame', { tabId, width: 800, height: 450 })
  assert.equal(Buffer.from(frame.image, 'base64').toString(), 'https://example.test/second at 800x450')
  assert.deepEqual(await call('frame', { tabId }), { ...frame, image: null })
  for (const payload of [{ kind: 'click', x: 1, y: 2 }, { kind: 'move', x: 3, y: 4 }, { kind: 'wheel', deltaY: 20 },
    { kind: 'keydown', key: 'Enter' }, { kind: 'keyup', key: 'Enter' }, { kind: 'type', text: 'abc' }]) {
    assert.deepEqual(await call('input', { tabId, ...payload }), { ok: true })
  }
  assert.deepEqual(calls, ['context', 'reload', 'Page.stopLoading', ['click', 1, 2, { button: 'left' }],
    ['move', 3, 4], ['wheel', 0, 20], ['down', 'Enter'], ['up', 'Enter'], ['insertText', 'abc']])
  assert.deepEqual(await manager.readActivePage('one'), { title: '/second', url: 'https://example.test/second',
    text: '# Report\n\nOpen [#1]', items: [{ role: 'link', name: 'Open' }], format: 'markdown' })
  const another = await call('open', {}, 'two')
  await assert.rejects(call('frame', { tabId }, 'two'), { code: 'bot/not-found' })
  assert.equal((await call('list', {}, 'two')).activeTabId, another.tabId)
  assert.equal(launch.mock.callCount(), 1)
  const second = await call('open', { url: 'https://example.test/third' })
  assert.equal((await call('list')).activeTabId, second.tabId)
  assert.equal((await call('frame', { tabId })).url, 'https://example.test/second')
  assert.equal((await call('list')).activeTabId, second.tabId)
  assert.equal((await manager.readActivePage('one')).title, '/third')
  await call('input', { tabId, kind: 'type', text: 'Switch back to the first tab' })
  assert.equal((await call('list')).activeTabId, tabId)
  assert.equal((await manager.readActivePage('one')).title, '/second')
  assert.deepEqual(await call('close', { tabId }), { ok: true })
  assert.equal((await call('list')).activeTabId, second.tabId)
  await manager.drop('two')
  assert.deepEqual(await call('list', {}, 'two'), { tabs: [], activeTabId: null })
})

function readerFor(manager) {
  const rt = { config: {}, serverMode: true, ctx: { effect() {} }, teamTools: [], onBotDelete() {},
    load: async () => {}, selfOf: id => id, botOf: id => id === 'one' ? { id } : undefined }
  installBrowser(rt)
  rt.serverBrowser = manager
  const tool = rt.teamTools.find(entry => entry.name === 'read_browser')
  return { channel: rt.browserChannel, read: () => tool.execute({}, { agent: { id: 'one' } }) }
}

test('read_browser prefers an Electron response and falls back to the active server tab', async t => {
  const { browser } = fakeBrowser()
  const manager = createServerBrowser({ launch: async () => browser })
  t.after(() => manager.dispose())
  const { channel, read } = readerFor(manager)
  assert.equal(await read(), NO_PAGE)
  await manager.call('browser-tab-open', 'one', { url: 'https://example.test/report' })
  assert.match(await read(), /# Report\n\nOpen \[#1\][\s\S]*\[#1\] link "Open"/)
  channel.read = async () => ({ page: { url: 'https://example.test/electron', text: 'Desktop page' } })
  assert.match(await read(), /Desktop page/)
})

async function chromiumInstalled() {
  const { chromium } = await import('playwright-core')
  // Headless shell is a separate download from full Chromium.
  const full = chromium.executablePath()
  const shell = full.replace(/([/\\])chromium-(\d+)([/\\]).*/, '$1chromium_headless_shell-$2')
  return existsSync(shell) || existsSync(full)
}

test('real Chromium serves JPEG frames and reads marked Markdown after remote input', async t => {
  if (!await chromiumInstalled()) return t.skip('Playwright Chromium is not installed')
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(`<title>Report</title><h1>Report</h1><a href="/other">Next report</a><input autofocus><button onclick="this.textContent='Clicked'">Click me</button><p hidden>not visible</p>`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const manager = createServerBrowser()
  t.after(async () => { await manager.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const call = (name, body) => manager.call(`browser-tab-${name}`, 'one', body)
  const url = `http://127.0.0.1:${server.address().port}/report`
  const { tabId, error, title } = await call('open', { url })
  assert.equal(error, null)
  assert.equal(title, 'Report')
  const page = await manager.readActivePage('one')
  assert.deepEqual(Object.keys(page).sort(), ['format', 'items', 'text', 'title', 'url'])
  assert.equal(page.format, 'markdown')
  assert.match(page.text, /# Report/)
  assert.match(page.text, /Next report \[#1\]/)
  assert.doesNotMatch(page.text, /not visible/)
  assert.deepEqual(page.items[0], { role: 'link', name: 'Next report', href: new URL('/other', url).href })
  assert.equal(page.title, 'Report')
  assert.equal(page.url, url)
  assert.match(await readerFor(manager).read(), /\[#1\] link "Next report"/)
  const frame = await call('frame', { tabId, width: 640, height: 480 })
  assert.equal(Buffer.from(frame.image, 'base64').subarray(0, 2).toString('hex'), 'ffd8')
  assert.deepEqual([frame.width, frame.height], [640, 480])
  await call('input', { tabId, kind: 'type', text: 'private input' })
  await call('input', { tabId, kind: 'keydown', key: 'Tab' })
  await call('input', { tabId, kind: 'keyup', key: 'Tab' })
  await call('input', { tabId, kind: 'keydown', key: 'Enter' })
  await call('input', { tabId, kind: 'keyup', key: 'Enter' })
  const updated = await manager.readActivePage('one')
  assert.match(updated.text, /Clicked/)
  assert.doesNotMatch(updated.text, /private input/)
})

test('owner input reaches the exact tab a Bot hands off and the Bot resumes on that tab', async t => {
  if (!await chromiumInstalled()) return t.skip('Playwright Chromium is not installed')
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-shared-browser-'))
  t.mock.property(process, 'env', { ...process.env, DSH_HOME: home, DS_BOT_APP: '' })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['chief'], bots: { chief: { id: 'chief', name: 'Chief', instructions: '' } },
  }))
  const ctx = fakeContext()
  const agent = { ...ctx.scopeAgent('chief'), followup() {} }
  ctx.sessionController = { resolveAgent: async () => ({ agent }) }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { get: () => undefined }
  const rt = createRuntime(ctx, { home, serverMode: true, browserPlugin: 'refs' })
  const fixture = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(`<title>Handoff fixture</title><h1>${req.url === '/held' ? 'Waiting for owner' : 'Other tab'}</h1>
      <input autofocus aria-label="Owner answer" oninput="document.querySelector('h1').textContent = this.value">`)
  })
  t.after(async () => {
    await ctx.dispose()
    fixture.closeAllConnections()
    await new Promise(resolve => fixture.close(resolve))
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  fixture.listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  const url = `http://127.0.0.1:${fixture.address().port}/held`
  await rt.load()
  await rt.resolveAgent('chief')
  const run = (name, args = {}) => ctx.registeredTools.get(name).execute(args, { agent, callId: 'handoff-1' })
  const call = async (name, extra = {}) => {
    const result = await rt.channelCall(name, { botId: 'chief', ...extra })
    assert.equal(result.ok, true, JSON.stringify(result.error))
    return result.value
  }
  const hold = async () => (await call('state')).browserHolds.chief

  await run('browser_open', { url })
  const initial = await call('browser-tab-list')
  assert.equal(initial.tabs.length, 1)
  const [{ tabId }] = initial.tabs
  assert.equal(initial.tabs[0].url, url)
  const other = await call('browser-tab-open', { url: new URL('/other', url).href })
  await run('browser_tabs', { action: 'select', index: 1 })
  assert.equal((await call('browser-tab-list')).activeTabId, other.tabId)
  assert.match(await run('read_browser'), /Other tab/)
  const selected = await call('browser-tab-select', { tabId })
  assert.equal(selected.tabId, tabId)
  assert.equal(selected.url, url)
  assert.equal((await call('browser-tab-list')).activeTabId, tabId)
  assert.match(await run('read_browser'), /Waiting for owner/)
  assert.ok((await run('browser_snapshot')).includes(`URL: ${url}\n`))

  // Even if the owner has been viewing a different tab, the handoff selects the Bot's tab.
  await call('browser-tab-input', { tabId: other.tabId, kind: 'keydown', key: 'Shift' })
  await call('browser-tab-input', { tabId: other.tabId, kind: 'keyup', key: 'Shift' })
  assert.equal((await call('browser-tab-list')).activeTabId, other.tabId)
  assert.match((await run('browser_handoff', { reason: 'login' })).text, /Waiting for the user/)
  assert.equal((await call('browser-tab-frame', { tabId: other.tabId })).url, other.url)
  assert.equal((await hold()).by, 'bot')
  await assert.rejects(run('browser_snapshot'), /waiting for the user/)
  await assert.rejects(run('browser_resume'), /waiting for the user/)
  assert.equal((await call('browser-tab-list')).activeTabId, tabId)
  const frame = await call('browser-tab-frame', { tabId })
  assert.equal(frame.url, url)
  assert.equal(Buffer.from(frame.image, 'base64').subarray(0, 2).toString('hex'), 'ffd8')

  await call('browser-tab-input', { tabId, kind: 'type', text: 'Owner took' })
  assert.notEqual((await call('browser-tab-frame', { tabId })).image, null)
  await call('browser-takeover')
  assert.equal((await hold()).by, 'user')
  await assert.rejects(run('browser_snapshot'), /taken over/)
  await call('browser-tab-input', { tabId, kind: 'type', text: ' control' })
  assert.notEqual((await call('browser-tab-frame', { tabId })).image, null)
  const duringHold = await call('browser-tab-open', { url: new URL('/during-hold', url).href })
  assert.equal((await call('browser-tab-list')).activeTabId, duringHold.tabId)
  assert.equal((await call('browser-tab-select', { tabId: other.tabId })).tabId, other.tabId)
  assert.equal((await call('browser-tab-list')).activeTabId, other.tabId)
  assert.match(await run('read_browser'), /Other tab/)
  await call('browser-give-back', { callId: 'handoff-1', outcome: 'done' })
  const resumed = await run('browser_snapshot')
  assert.ok(resumed.includes(`URL: ${url}\n`), resumed)
  assert.match(resumed, /Owner took control/)
  assert.doesNotMatch(resumed, /heading "Other tab"/)

  for (const [action, reason] of [['takeover', 'takeover'], ['stop', 'stopped']]) {
    await call('browser-tab-input', { tabId: other.tabId, kind: 'keydown', key: 'Shift' })
    await call('browser-tab-input', { tabId: other.tabId, kind: 'keyup', key: 'Shift' })
    assert.equal((await call('browser-tab-list')).activeTabId, other.tabId)
    await call(`browser-${action}`)
    assert.equal((await call('browser-tab-frame', { tabId: other.tabId })).url, other.url)
    assert.equal((await hold()).reason, reason)
    await assert.rejects(run('browser_snapshot'), /taken over/)
    const { activeTabId } = await call('browser-tab-list')
    assert.equal(activeTabId, tabId)
    assert.equal((await call('browser-tab-frame', { tabId: activeTabId })).url, url)
    await call('browser-tab-input', { tabId: activeTabId, kind: 'type', text: ` after ${action}` })
    const extra = await call('browser-tab-open', { url: new URL(`/during-${action}`, url).href })
    assert.equal((await call('browser-tab-list')).activeTabId, extra.tabId)
    await call('browser-give-back')
    const snapshot = await run('browser_snapshot')
    assert.ok(snapshot.includes(`URL: ${url}\n`), snapshot)
    assert.match(snapshot, new RegExp(`Owner took control after takeover${action === 'stop' ? ' after stop' : ''}`))
  }
})
