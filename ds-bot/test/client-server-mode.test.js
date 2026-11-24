import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { act, createElement as h, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { ServerAbout } from '../src/client/about.js'
import { browserNotify, noticeApprovals } from '../src/client/approval-notices.js'
import { createServerBotBrowsers } from '../src/client/bot-browsers.js'
import { ComputerIndicator } from '../src/client/computer.js'
import { NotificationsRow, NotificationWatcher } from '../src/client/notifications.js'
import { createSource, indexRoster } from '../src/client/sources.js'

const { JSDOM } = createRequire(join(process.env.DSH_HARNESS, 'package.json'))('jsdom')
const { outputFiles } = await build({
  stdin: { contents: `
    export { BrowserView, ServerBrowserViewport } from './src/client/browser-pane.js'
    export { browserControlActions } from './src/client/bot-browsers.js'
  `, resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const require = createRequire(import.meta.url)
const module = { exports: {} }
const scope = { module, exports: module.exports, require: name => name.startsWith('@deepseek-ai/') ? {} : require(name), AbortController, setTimeout, clearTimeout, fetch }
runInNewContext(outputFiles[0].text, scope)
const { BrowserView, ServerBrowserViewport, browserControlActions } = module.exports

const server = { enabled: true, hostname: 'mac-mini-1', dshHome: '/example/dsh', canRestart: true }
const bot = { id: 'main', name: 'Main', sessionId: 'main-part' }
const room = { id: 'room', name: 'Room', sessionId: 'room-part' }
const roster = indexRoster({ bots: [bot], rooms: [room], server })
const snapshot = source => select => select(useSyncExternalStore(source.subscribe, source.getSnapshot))

async function withDom(t, fn) {
  const dom = new JSDOM('<!doctype html><title>Harness</title><div id="root"></div>', { url: 'https://example.test', pretendToBeVisual: true })
  const { window } = dom
  t.mock.method(window, 'focus', () => {})
  const mounted = window.document.querySelector('#root')
  const values = { window, document: window.document, localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true }
  const descriptors = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true })
  scope.document = window.document
  scope.window = window
  const root = createRoot(mounted)
  try { await fn(window, mounted, (component) => act(async () => root.render(component))) }
  finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    dom.window.close()
  }
}

function fakeNotifications(t) {
  const notices = []
  class Note {
    static permission = 'default'
    static async requestPermission() { Note.permission = 'granted'; return Note.permission }
    constructor(title, { tag }) { this.title = title; this.tag = tag; notices.push(this) }
    close() { this.closed = true }
  }
  Object.defineProperty(globalThis, 'Notification', { value: Note, configurable: true })
  t.after(() => { delete globalThis.Notification })
  return { Note, notices }
}

test('server tab title counts unread and waiting chats once and restores the original title', async (t) => withDom(t, async (window, _, render) => {
  const { Note, notices } = fakeNotifications(t)
  Note.permission = 'granted'
  const statuses = createSource(new Map())
  const work = createSource({ approvals: [] })
  const opened = []
  await render(h(NotificationWatcher, {
    useRoster: select => select(roster), useSessions: select => select({ byId: {} }),
    useSessionStatus: snapshot(statuses), useWork: snapshot(work), actions: { openSession: id => opened.push(id) },
  }))
  assert.equal(document.title, 'mac-mini-1 · DS Bot')
  await act(async () => {
    statuses.set(new Map([['main-part', { completionUnread: true }]]))
    work.set({ approvals: [{ id: 'a', botId: 'main' }, { id: 'b', botId: 'main', roomId: 'room' }] })
  })
  assert.equal(document.title, '(2) mac-mini-1 · DS Bot')
  assert.equal(notices.length, 1)
  notices[0].onclick()
  assert.deepEqual(opened, ['main'])
  assert.equal(notices[0].closed, true)
  assert.equal(window.focus.mock.callCount(), 1)
  await render(null)
  assert.equal(document.title, 'Harness')
}))

test('browser permission is requested from Settings, and approval notices open the right chat', async (t) => withDom(t, async (_, mounted, render) => {
  const { notices } = fakeNotifications(t)
  await render(h(NotificationsRow))
  assert.match(mounted.textContent, /Browser notifications need permission/)
  await act(async () => mounted.querySelector('.bt-soft').click())
  assert.match(mounted.textContent, /Browser notifications are allowed/)
  assert.equal(mounted.querySelector('.bt-soft'), null)
  const work = createSource({ approvals: [] })
  const opened = []
  const stop = noticeApprovals({ work, roster: createSource(roster), since: 1, shownSession: () => 'main-part', openSession: id => opened.push(id) })
  const approvals = [{ id: 'old', at: 0, botId: bot.id }, { id: 'new', at: 2, botId: bot.id, roomId: room.id }]
  work.set({ approvals })
  work.set({ approvals })
  assert.deepEqual(notices.map(note => note.tag), ['ds-bot-approval-new'])
  notices[0].onclick()
  assert.deepEqual(opened, ['room'])
  stop()
}))

for (const secure of [false, true]) {
  test(`browser notifications respect a ${secure ? 'secure' : 'non-secure'} context`, async (t) => withDom(t, async (_, mounted, render) => {
    const { Note, notices } = fakeNotifications(t)
    Object.defineProperty(globalThis, 'isSecureContext', { value: secure, configurable: true })
    t.after(() => { delete globalThis.isSecureContext })
    await render(h(NotificationsRow))
    if (secure) {
      assert.match(mounted.textContent, /Browser notifications need permission/)
      await act(async () => mounted.querySelector('.bt-soft').click())
      assert.match(mounted.textContent, /Browser notifications are allowed/)
    } else {
      assert.match(mounted.textContent, /Browser notifications require HTTPS or localhost/)
      assert.equal(mounted.querySelector('.bt-soft'), null)
      assert.equal(Note.permission, 'default')
      Note.permission = 'granted'
    }
    browserNotify({ title: 'Test notice' }, () => {})
    assert.equal(notices.length, secure ? 1 : 0)
  }))
}

for (const canRestart of [true, false]) {
  test(`About shows server details and restart availability for a ${canRestart ? 'managed' : 'non-managed'} server`, async (t) => withDom(t, async (_, mounted, render) => {
    const calls = []
    const info = { ...server, version: '1.2.3', hostname: 'test-host', platform: 'linux', dshHome: '/test/data', unrestricted: canRestart, canRestart }
    t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
      const { endpoint } = JSON.parse(body)
      calls.push(endpoint)
      return { ok: true, json: async () => ({ ok: true, value: endpoint === 'server-info' ? info : { restarting: true } }) }
    })
    const Section = ({ children }) => h('section', null, children)
    const Row = ({ hint, label, children }) => h('div', { 'data-label': label }, hint, children)
    const hint = label => mounted.querySelector(`[data-label="${label}"]`).textContent
    await render(h(ServerAbout, { server, version: 'fallback', run: promise => promise.then(() => true), Section, Row }))
    assert.equal(hint('Server version'), '1.2.3')
    assert.equal(hint('Hostname'), 'test-host')
    assert.equal(hint('Platform'), 'linux')
    assert.equal(hint('Data location'), '/test/data')
    assert.equal(hint('Unrestricted mode'), canRestart ? 'Enabled' : 'Disabled')
    if (canRestart) {
      assert.match(hint('Server restart'), /Managed by a supervisor/)
      await act(async () => mounted.querySelector('button').click())
      assert.deepEqual(calls, ['server-info', 'server-restart'])
      assert.equal(mounted.querySelector('button').disabled, true)
    } else {
      assert.match(hint('Server restart'), /No supervisor is configured/)
      assert.equal(mounted.querySelector('button'), null)
      assert.deepEqual(calls, ['server-info'])
    }
  }))
}

test('server tabs reuse the active tab, send navigation and input, and retain a frame when unchanged', async () => {
  const calls = []
  const report = error => assert.fail(error)
  const initial = { tabId: 't1', url: 'https://example.test/', title: 'Example' }
  const input = { kind: 'wheel', x: 20, y: 50, deltaY: 40 }
  let image = 'jpeg'
  const browsers = createServerBotBrowsers({ createSource, report, async call(endpoint, payload) {
    calls.push([endpoint, payload])
    switch (endpoint) {
      case 'browser-tab-list': return { tabs: [initial], activeTabId: 't1' }
      case 'browser-tab-open': return { tabId: 't2', url: 'about:blank' }
      case 'browser-tab-nav': return { tabId: 't2', url: payload.url }
      case 'browser-tab-cmd': return { tabId: 't2', url: initial.url, canGoBack: false }
      case 'browser-tab-frame': return { ...initial, tabId: 't2', image, width: 600, height: 400, updatedAt: 10 }
      default: return { ok: true }
    }
  } })
  assert.equal(await browsers.openTab('main', true), 't1')
  assert.equal(await browsers.openTab('main'), 't2')
  assert.equal(browsers.pages.getSnapshot().t2.url, '')
  assert.equal(await browsers.navigate('t2', 'file:///example'), false)
  assert.equal(await browsers.navigate('t2', initial.url), true)
  await browsers.command('t2', 'reload')
  const signal = new AbortController().signal
  await browsers.frame('t2', 600, 400, signal)
  image = null
  await browsers.frame('t2', 600, 400, signal)
  assert.equal(browsers.cachedFrame('t2').image, 'jpeg')
  assert.equal(Object.hasOwn(browsers.pages.getSnapshot().t2, 'image'), false)
  await browsers.input('t2', input)
  await browsers.closeTab('main', 't2')
  assert.equal(browsers.cachedFrame('t2'), null)
  assert.deepEqual(browsers.tabs.getSnapshot().main, { ids: ['t1'], active: 't1' })
  assert.deepEqual(calls, [
    ['browser-tab-list', { botId: 'main' }], ['browser-tab-open', { botId: 'main' }],
    ['browser-tab-nav', { botId: 'main', tabId: 't2', url: initial.url }],
    ['browser-tab-cmd', { botId: 'main', tabId: 't2', command: 'reload' }],
    ['browser-tab-frame', { botId: 'main', tabId: 't2', width: 600, height: 400 }],
    ['browser-tab-frame', { botId: 'main', tabId: 't2', width: 600, height: 400 }],
    ['browser-tab-input', { botId: 'main', tabId: 't2', ...input }],
    ['browser-tab-close', { botId: 'main', tabId: 't2' }],
  ])
  browsers.dispose()
})

test('explicit server tab selection sends browser-tab-select; list and frame reads do not', async () => {
  const calls = []
  const tabs = [{ tabId: 't1', url: 'https://example.test/' }, { tabId: 't2', url: '' }]
  const browsers = createServerBotBrowsers({ createSource, report: error => assert.fail(error), async call(endpoint, payload) {
    calls.push([endpoint, payload])
    if (endpoint === 'browser-tab-list') return { tabs, activeTabId: 't1' }
    if (endpoint === 'browser-tab-frame') return { ...tabs[1], image: null }
    return { ok: true }
  } })
  await browsers.ensureTabs(bot.id)
  assert.equal(browsers.tabs.getSnapshot()[bot.id].active, 't1')
  await browsers.activate(bot.id, 't2')
  assert.equal(browsers.tabs.getSnapshot()[bot.id].active, 't2')
  await browsers.frame('t2', 600, 400, new AbortController().signal)
  await browsers.ensureTabs(bot.id)
  await browsers.activate(bot.id, 'missing')
  assert.deepEqual(calls, [
    ['browser-tab-list', { botId: bot.id }],
    ['browser-tab-select', { botId: bot.id, tabId: 't2' }],
    ['browser-tab-frame', { botId: bot.id, tabId: 't2', width: 600, height: 400 }],
    ['browser-tab-list', { botId: bot.id }],
  ])
  browsers.dispose()
})

test('server browser controls send takeover, stop, and give-back requests without Electron views', async (t) => {
  const requests = []
  t.mock.method(scope, 'fetch', async (url, { method, body }) => {
    requests.push({ url, method, ...JSON.parse(body) })
    return { ok: true, json: async () => ({ ok: true, value: true }) }
  })
  const browsers = createServerBotBrowsers({ createSource, call: async () => ({ tabs: [], activeTabId: null }) })
  const controls = browserControlActions(null, browsers, createSource({ browserMode: 'server' }))
  assert.equal(await controls.browserTakeover(bot.id), true)
  assert.equal(await controls.browserStop(bot.id), true)
  assert.equal(await controls.browserGiveBack(bot.id), true)
  assert.equal(await controls.browserGiveBack(bot.id, { callId: 'handoff', outcome: 'done' }), true)
  assert.deepEqual(requests, [
    { url: 'api/bot', method: 'POST', endpoint: 'browser-takeover', payload: { botId: bot.id } },
    { url: 'api/bot', method: 'POST', endpoint: 'browser-stop', payload: { botId: bot.id } },
    { url: 'api/bot', method: 'POST', endpoint: 'browser-give-back', payload: { botId: bot.id } },
    { url: 'api/bot', method: 'POST', endpoint: 'browser-give-back', payload: { botId: bot.id, callId: 'handoff', outcome: 'done' } },
  ])
})

test('browser control availability follows the active backend and native hold is optional', async (t) => {
  t.mock.method(scope, 'fetch', async () => ({ ok: true, json: async () => ({ ok: true, value: true }) }))
  const state = createSource({ browserMode: 'electron' })
  const browsers = createServerBotBrowsers({ createSource, call: async () => ({ tabs: [], activeTabId: null }) })
  const controls = browserControlActions({}, browsers, state)
  assert.equal(controls.browserTakeover, undefined)
  assert.equal(controls.browserStop, undefined)
  assert.equal(controls.browserGiveBack, undefined)
  const native = browserControlActions({ views: {} }, browsers, state)
  assert.equal(await native.browserTakeover(bot.id), true)
  assert.deepEqual(browsers.holds.getSnapshot(), {})
  state.set({ browserMode: 'server' })
  assert.equal(await controls.browserTakeover(bot.id), true)
  assert.equal(browsers.holds.getSnapshot()[bot.id].by, 'user')
})

test('server mode updates server holds even when the native bridge is available', async (t) => {
  t.mock.method(scope, 'fetch', async () => ({ ok: true, json: async () => ({ ok: true, value: true }) }))
  const state = createSource({ browserMode: 'server' })
  const browsers = createServerBotBrowsers({ createSource, call: async () => ({ tabs: [], activeTabId: null }) })
  const hold = t.mock.fn()
  const controls = browserControlActions({ views: { hold } }, browsers, state)

  await controls.browserTakeover(bot.id)
  assert.deepEqual(browsers.holds.getSnapshot()[bot.id], { by: 'user', reason: 'takeover' })
  await controls.browserStop(bot.id)
  assert.deepEqual(browsers.holds.getSnapshot()[bot.id], { by: 'user', reason: 'stopped' })
  await controls.browserGiveBack(bot.id)
  assert.deepEqual(browsers.holds.getSnapshot(), {})
  assert.equal(hold.mock.callCount(), 0)

  state.set({ browserMode: 'electron' })
  await controls.browserTakeover(bot.id)
  assert.equal(hold.mock.callCount(), 1)
  assert.deepEqual(Array.from(hold.mock.calls[0].arguments), [bot.id, true])
  assert.deepEqual(browsers.holds.getSnapshot(), {})
})

test('server tab selection follows the host on takeover, stop, and held-tab list refreshes', async (t) => {
  t.mock.method(scope, 'fetch', async () => ({ ok: true, json: async () => ({ ok: true, value: true }) }))
  const state = createSource({ browserMode: 'server' })
  let activeTabId = 'local'
  let finishList
  const browsers = createServerBotBrowsers({ createSource, report: error => assert.fail(error), async call(endpoint) {
    if (endpoint === 'browser-tab-select') return { ok: true }
    assert.equal(endpoint, 'browser-tab-list')
    const response = { tabs: [{ tabId: 'local', url: '' }, { tabId: 'held', url: '' }], activeTabId }
    if (finishList === undefined) return response
    return new Promise(resolve => { finishList = () => resolve(response) })
  } })
  const controls = browserControlActions(null, browsers, state)
  const active = () => browsers.tabs.getSnapshot()[bot.id].active
  await browsers.ensureTabs(bot.id)
  assert.equal(active(), 'local')
  activeTabId = 'held'
  await browsers.ensureTabs(bot.id)
  assert.equal(active(), 'local', 'ordinary refreshes preserve the owner’s selection')
  await controls.browserTakeover(bot.id)
  assert.equal(active(), 'held')
  await controls.browserGiveBack(bot.id)
  await browsers.activate(bot.id, 'local')
  await controls.browserStop(bot.id)
  assert.equal(active(), 'held')
  activeTabId = 'local'
  await browsers.ensureTabs(bot.id)
  assert.equal(active(), 'local', 'a list response during a hold follows the host')

  await controls.browserGiveBack(bot.id)
  activeTabId = 'held'
  finishList = null
  browsers.setHolds({ [bot.id]: { by: 'bot', reason: 'other' } })
  assert.equal(await browsers.frame('local', 400, 300, new AbortController().signal), null)
  const synced = browsers.ensureTabs(bot.id)
  finishList()
  await synced
  assert.equal(active(), 'held')
  browsers.dispose()
})

test('BrowserView reacts to server holds after takeover, stop, and give back', async (t) => withDom(t, async (_, mounted, render) => {
  const calls = []
  t.mock.method(scope, 'fetch', async (_url, { body }) => {
    const { endpoint, payload } = JSON.parse(body)
    assert.equal(payload.botId, bot.id)
    calls.push(endpoint)
    return { ok: true, json: async () => ({ ok: true, value: true }) }
  })
  const browsers = createServerBotBrowsers({ createSource, call: async () => ({ tabs: [], activeTabId: null }) })
  const actions = browserControlActions(null, browsers, createSource({ browserMode: 'server' }))
  const useBrowserHolds = snapshot(browsers.holds)
  function Pane() {
    const hold = useBrowserHolds(map => map[bot.id])
    return h(BrowserView, { bot, actions, hold, useBrowserPages: snapshot(browsers.pages), server: true })
  }
  const buttons = () => Array.from(mounted.querySelectorAll('.bt-browser-takeover button'))
  const labels = () => buttons().map(button => button.textContent)
  const click = name => act(async () => buttons().find(button => button.textContent === name).click())
  await render(h(Pane))
  for (const name of ['Take over', 'Stop']) {
    assert.deepEqual(labels(), ['Take over', 'Stop'])
    await click(name)
    assert.deepEqual(labels(), ['Give back'])
    await click('Give back')
    assert.deepEqual(labels(), ['Take over', 'Stop'])
  }
  await act(async () => browsers.setHolds({ [bot.id]: { by: 'bot', reason: 'other' } }))
  assert.deepEqual(labels(), ['Give back'])
  await act(async () => browsers.setHolds({}))
  assert.deepEqual(labels(), ['Take over', 'Stop'])
  assert.deepEqual(calls, ['browser-takeover', 'browser-give-back', 'browser-stop', 'browser-give-back'])
}))

test('BrowserView discovers navigation from blank pages and recovery from errors without address input', async (t) => withDom(t, async (window, mounted, render) => {
  t.mock.method(window.HTMLElement.prototype, 'getBoundingClientRect', () => ({ width: 400, height: 300, left: 0, top: 0 }))
  t.mock.method(window.HTMLElement.prototype, 'focus', () => {})
  let nextPoll
  t.mock.method(scope, 'setTimeout', (poll) => { nextPoll = poll; return 1 })
  t.mock.method(scope, 'clearTimeout', () => { nextPoll = undefined })
  const tabId = 't1'
  const url = 'https://example.test/'
  let remote = { tabId, url: 'about:blank', error: null, image: null, updatedAt: null }
  const browsers = createServerBotBrowsers({ createSource, report: error => assert.fail(error), async call(endpoint) {
    if (endpoint === 'browser-tab-list') return { tabs: [remote], activeTabId: tabId }
    assert.equal(endpoint, 'browser-tab-frame', 'only polling may change the tab')
    return { ...remote, width: 400, height: 300 }
  } })
  await browsers.ensureTabs(bot.id)
  const useBrowserPages = snapshot(browsers.pages)
  const actions = { browserFrame: browsers.frame, browserInput: browsers.input }
  const poll = async (state) => {
    remote = { tabId, ...state }
    assert.equal(typeof nextPoll, 'function')
    await act(async () => nextPoll())
  }
  try {
    await render(h(BrowserView, { bot, tabId, actions, useBrowserPages, landed: true, server: true }))
    assert.match(mounted.querySelector('.bt-browser-empty').textContent, /Open a page here/)
    assert.equal(mounted.querySelector('.bt-browser-remote'), null)
    await poll({ url, error: null, image: 'Zmlyc3Q=', updatedAt: 1 })
    assert.equal(mounted.querySelector('.bt-browser-empty'), null)
    assert.equal(mounted.querySelector('.bt-browser-remote img').src, 'data:image/jpeg;base64,Zmlyc3Q=')

    await poll({ url, error: 'Host navigation failed', image: null, updatedAt: 1 })
    assert.match(mounted.querySelector('.bt-browser-empty').textContent, /Host navigation failed/)
    assert.equal(mounted.querySelector('.bt-browser-remote'), null)
    await poll({ url, error: null, image: 'c2Vjb25k', updatedAt: 2 })
    assert.equal(mounted.querySelector('.bt-browser-empty'), null)
    assert.equal(mounted.querySelector('.bt-browser-remote img').src, 'data:image/jpeg;base64,c2Vjb25k')
    await render(null)
    assert.equal(nextPoll, undefined)
  } finally { browsers.dispose() }
}))

test('remote viewport renders a JPEG and forwards scaled mouse, wheel, keyboard and clipboard input', async (t) => withDom(t, async (window, mounted, render) => {
  t.mock.method(window.HTMLElement.prototype, 'getBoundingClientRect', () => ({ width: 400, height: 400, left: 10, top: 20 }))
  const received = []
  let signal
  const actions = {
    browserFrame: async (tabId, width, height, requestSignal) => {
      assert.deepEqual([tabId, width, height], ['t2', 400, 400])
      signal = requestSignal
      return { width: 800, height: 400, image: 'aW1hZ2U=' }
    },
    browserInput: async (tabId, event) => received.push({ tabId, ...event }),
  }
  await render(h(ServerBrowserViewport, { actions, tabId: 't2' }))
  const view = mounted.querySelector('.bt-browser-remote')
  const img = view.querySelector('img')
  assert.equal(img.src, 'data:image/jpeg;base64,aW1hZ2U=')
  await act(async () => {
    img.dispatchEvent(new window.Event('load'))
    view.dispatchEvent(new window.MouseEvent('click', { clientX: 110, clientY: 170, bubbles: true, cancelable: true }))
    view.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 120, clientY: 170, bubbles: true }))
    view.dispatchEvent(new window.WheelEvent('wheel', { clientX: 120, clientY: 170, deltaY: 12, bubbles: true, cancelable: true }))
    view.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    view.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'a', bubbles: true }))
    const paste = new window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'hello' } })
    view.dispatchEvent(paste)
  })
  assert.deepEqual(received, [
    { tabId: 't2', kind: 'click', x: 200, y: 100, button: 'left' },
    { tabId: 't2', kind: 'move', x: 220, y: 100 }, { tabId: 't2', kind: 'wheel', x: 220, y: 100, deltaX: 0, deltaY: 12 },
    { tabId: 't2', kind: 'keydown', key: 'a' }, { tabId: 't2', kind: 'keyup', key: 'a' },
    { tabId: 't2', kind: 'type', text: 'hello' },
  ])
  await render(null)
  assert.equal(signal.aborted, true)
}))

test('remote keyup uses the key originally sent even when Shift is released first', async (t) => withDom(t, async (window, mounted, render) => {
  const received = []
  const actions = { browserInput: async (_tabId, event) => received.push({ ...event }) }
  await render(h(ServerBrowserViewport, { actions, tabId: 't1' }))
  const view = mounted.querySelector('.bt-browser-remote')
  const key = (type, code, value, shiftKey) => view.dispatchEvent(new window.KeyboardEvent(type, { code, key: value, shiftKey, bubbles: true, cancelable: true }))
  await act(async () => {
    key('keydown', 'ShiftLeft', 'Shift', true)
    key('keydown', 'KeyA', 'A', true)
    key('keyup', 'ShiftLeft', 'Shift', false)
    key('keyup', 'KeyA', 'a', false)
  })
  assert.deepEqual(received, [
    { kind: 'keydown', key: 'Shift' }, { kind: 'keydown', key: 'A' },
    { kind: 'keyup', key: 'Shift' }, { kind: 'keyup', key: 'A' },
  ])
  await render(null)
  assert.equal(received.length, 4, 'no key remains pressed at unmount')
}))

test('computer status shows held and active Bots and the preview follows new screenshots', async (t) => withDom(t, async (window, mounted, render) => {
  Object.defineProperty(window.HTMLDialogElement.prototype, 'showModal', { value() { this.open = true } })
  const held = { ...bot, id: 'held', name: 'Held' }
  const live = createSource({ holds: { held: { by: 'user' } }, bots: { main: { state: 'bot', lastShot: { attachmentId: 'first' } } } })
  const viewRoster = { ...roster, byId: { ...roster.byId, held } }
  const calls = []
  const actions = {
    computerShot: async id => { calls.push(id); return { dataUrl: `data:image/png;base64,${id}` } },
    computerStop: id => calls.push(`stop:${id}`), computerHandback: id => calls.push(`handback:${id}`),
  }
  await render(h(ComputerIndicator, { useComputer: snapshot(live), useRoster: select => select(viewRoster), actions, browserTab: true }))
  assert.match(mounted.textContent, /HeldYou have the computerPreviewLet go/)
  await act(async () => mounted.querySelector('button[aria-haspopup="dialog"]').click())
  assert.match(mounted.querySelector('dialog img').src, /first$/)
  await act(async () => live.set(state => ({ ...state, bots: { main: { state: 'bot', lastShot: { attachmentId: 'second' } } } })))
  assert.match(mounted.querySelector('dialog img').src, /second$/)
  await act(async () => mounted.querySelector('dialog button').click())
  await act(async () => mounted.querySelector('button[aria-label="Stop"]').click())
  await act(async () => [...mounted.querySelectorAll('button')].find(button => button.textContent === 'Let go').click())
  assert.deepEqual(calls, ['first', 'second', 'stop:main', 'handback:held'])
}))
