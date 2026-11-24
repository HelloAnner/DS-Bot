import assert from 'node:assert/strict'
import { fork, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const plugin = fileURLToPath(new URL('../..', import.meta.url))

// Opt in: install the current plugin into server/ as described in server/README.md,
// then run `npx playwright-core install chromium` (full Chromium, not --only-shell).
// Set DS_BOT_SERVER_DIR to the absolute path of a separate server install with
// the current checkout bundle. BROWSER_EXECUTABLE_PATH selects another full
// Chromium executable. The check uses headed Chromium so it
// can switch real tabs. No existing DSH or Chromium profile is used.
test('authenticated loopback DS Bot delivers a Web Notification for a background reply', {
  skip: process.env.DS_BOT_TEST_WEB_NOTIFICATIONS !== '1' && 'set DS_BOT_TEST_WEB_NOTIFICATIONS=1 to run with full Chromium',
  timeout: 60_000,
}, async t => {
  const runner = resolve(process.env.DS_BOT_SERVER_DIR ?? join(plugin, '../server'))
  const require = createRequire(pathToFileURL(join(runner, 'index.mjs')))
  assert.ok(readFileSync(require.resolve('ds-bot/client')).equals(readFileSync(join(plugin, 'client.js'))),
    'the server must have the current generated DS Bot client installed')
  const home = mkdtempSync(join(tmpdir(), '.dsh-test-server-notifications-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const env = { PATH: process.env.PATH, HOME: home, DSH_HOME: home, DO_NOT_TRACK: '1' }
  const mock = spawn(process.execPath, [join(plugin, 'dev/mock-llm.mjs')], {
    cwd: home, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...env, MOCK_PORT: '0', MOCK_LOG: join(home, 'mock.jsonl') },
  })
  const mockExit = once(mock, 'exit')
  const lines = createInterface({ input: mock.stdout })
  let server, serverExit, browser
  try {
    const line = await Promise.race([
      once(lines, 'line', { signal: AbortSignal.timeout(5_000) }).then(([value]) => value),
      mockExit.then(() => { throw new Error('Mock model exited before readiness') }),
    ])
    const mockBase = /^ds-bot mock on (http:\/\/127\.0\.0\.1:\d+\/v1)$/.exec(line)?.[1]
    assert.ok(mockBase, 'mock model must listen on loopback')
    // The server resolves its own dependencies, not the test runner's relative preload.
    server = fork(join(runner, 'index.mjs'), ['start', '--home', home, '--port', '0'], {
      execArgv: [],
      cwd: home, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...env, DEEPSEEK_BASE_URL: mockBase, DEEPSEEK_API_KEY: 'mock-key' },
    })
    serverExit = once(server, 'exit')
    const [launch] = await Promise.race([
      once(server, 'message', { signal: AbortSignal.timeout(15_000) }),
      serverExit.then(([code, signal]) => { throw new Error(`DS Bot Server exited before readiness (${code ?? signal})`) }),
    ])
    assert.equal(launch.type, 'ready')
    const origin = new URL(launch.url).origin
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/)

    browser = await chromium.launch({
      headless: false,
      ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : { channel: 'chromium' }),
    })
    const context = await browser.newContext({ locale: 'en-US', reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } })
    const unauthenticated = await context.request.post(`${origin}/api/bot`, { data: { endpoint: 'state', payload: {} } })
    assert.equal(unauthenticated.status(), 401)
    // Don't include the private launch URL in a Playwright failure message.
    const loginStatus = await context.request.get(launch.url, { maxRedirects: 0 }).then(response => response.status(), () => 0)
    assert.equal(loginStatus, 303)

    await context.addInitScript(() => {
      localStorage.setItem('ds-bot:settings-tour-v1', '1')
      const observed = []
      let focusCalls = 0
      const focus = window.focus
      window.focus = () => { focusCalls++; focus.call(window) }
      window.notificationEvidence = { observed, focusCalls: () => focusCalls }
      // Return the real Notification object. Chromium, not the test, dispatches show/error.
      window.Notification = new Proxy(window.Notification, {
        construct(target, args) {
          const note = Reflect.construct(target, args)
          const entry = { note, event: null, trusted: false, hidden: document.hidden, focused: document.hasFocus() }
          observed.push(entry)
          for (const event of ['show', 'error']) note.addEventListener(event, e => {
            entry.event = e.type
            entry.trusted = e.isTrusted
          })
          return note
        },
      })
    })
    const rpc = async (endpoint, payload = {}) => {
      const response = await context.request.post(`${origin}/api/bot`, { data: { endpoint, payload } })
      assert.equal(response.status(), 200, endpoint)
      const result = await response.json()
      assert.equal(result.ok, true, `${endpoint}: ${result.error?.code ?? ''}`)
      return result.value
    }
    const state = await rpc('state')
    const model = state.models.find(entry => entry.provider === 'deepseek-official')?.ref
    assert.ok(model, 'mock DeepSeek model must be listed')
    const name = 'Notification test Bot'
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    const navigation = await page.goto(origin)
    assert.equal(navigation.status(), 200)
    assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, bridge: Boolean(window.dsBotApp), permission: Notification.permission })),
      { secure: true, bridge: false, permission: 'default' })
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    const openSettings = async () => {
      await page.locator('.bt-leftcol-foot').getByRole('button', { name: 'Account', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
      await settings.getByRole('navigation').getByRole('button', { name: 'General', exact: true }).click()
    }
    const closeSettings = async () => {
      await page.keyboard.press('Escape')
      await settings.waitFor({ state: 'hidden' })
    }
    await page.locator(`[data-bot-id="${state.mainBotId}"][aria-current=page]`).waitFor()
    await openSettings()
    await settings.getByRole('button', { name: 'Enable browser notifications', exact: true }).waitFor()
    await closeSettings()
    // Grant permission in the fresh context without automating the browser-owned prompt.
    await context.grantPermissions(['notifications'], { origin })
    assert.equal(await page.evaluate(() => Notification.permission), 'granted')
    await openSettings()
    await settings.getByText('Browser notifications are allowed.', { exact: true }).waitFor()
    await closeSettings()

    const bot = await rpc('create-bot', { name, model })
    const chat = page.locator(`[data-bot-id="${bot.id}"]`)
    await chat.waitFor()
    await chat.click()
    await page.getByRole('paragraph').filter({ hasText: `Hi, I'm ${name}. Where should I start?` }).waitFor()
    await page.locator(`[data-bot-id="${state.mainBotId}"]`).click()
    await page.locator(`[data-bot-id="${state.mainBotId}"][aria-current=page]`).waitFor()

    // Playwright normally makes each target report itself as focused.
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    const otherTab = await context.newPage()
    await otherTab.bringToFront()
    await page.waitForFunction(() => !document.hasFocus() || document.hidden, null, { timeout: 10_000, polling: 100 })
    const tag = `ds-bot-chat-${bot.id}`
    await page.evaluate(() => { window.notificationEvidence.observed.length = 0 })
    await rpc('send', { sessionId: bot.id, text: 'Notification check' })
    const result = await (await page.waitForFunction(tag => {
      const entry = window.notificationEvidence.observed.find(item => item.note.tag === tag && item.event !== null)
      return entry && { event: entry.event, trusted: entry.trusted, title: entry.note.title, body: entry.note.body,
        background: entry.hidden || !entry.focused }
    }, tag, { timeout: 15_000, polling: 100 })).jsonValue()
    assert.deepEqual(result, { event: 'show', trusted: true, title: name, body: 'A new reply is waiting', background: true })
    assert.notEqual(await chat.getAttribute('aria-current'), 'page')
    const focusCalls = await page.evaluate(tag => {
      const { observed, focusCalls } = window.notificationEvidence
      const before = focusCalls()
      observed.find(item => item.note.tag === tag && item.event === 'show').note.dispatchEvent(new Event('click'))
      return focusCalls() - before
    }, tag)
    assert.equal(focusCalls, 1)
    await page.locator(`[data-bot-id="${bot.id}"][aria-current=page]`).waitFor()
    await page.getByRole('paragraph').filter({ hasText: '收到：Notification check' }).waitFor()
    t.diagnostic(`Chromium ${browser.version()} on ${origin}: GET / 200; state 401 before login, 200 after; secure=true, bridge=false; permission=default → granted; Settings shows allowed; trusted show in background; synthetic click called focus and opened the reply`)
    const gracefulExit = once(server, 'exit', { signal: AbortSignal.timeout(5_000) })
    server.kill('SIGTERM')
    assert.deepEqual(await gracefulExit, [0, null])
  } finally {
    try {
      await browser?.close()
    } finally {
      lines.close()
      server?.kill('SIGKILL')
      mock.kill('SIGTERM')
      await Promise.all([serverExit, mockExit])
    }
  }
})
