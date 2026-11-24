import { createHash, randomUUID } from 'node:crypto'
import { createSession } from './browser/session.js'

const DEFAULT_VIEWPORT = { width: 1280, height: 720 }
const MAX_TABS = 24
const TIMEOUT = 10_000
const METADATA_HOST = /^(169\.254\.\d+\.\d+|\[fd00:ec2::254\]|metadata\.google\.internal)$/i
const isMetadata = url => METADATA_HOST.test(url.hostname.replace(/\.$/, ''))
const browserError = (message, code = 'bot/invalid') => Object.assign(new Error(message), { code })

function address(value) {
  let url
  try { if (typeof value === 'string') url = new URL(value.trim()) } catch {}
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw browserError('Enter an HTTP or HTTPS address without credentials.')
  }
  if (isMetadata(url)) throw browserError('Cloud metadata addresses do not open here.', 'bot/forbidden')
  return url.href
}

function dimension(value, fallback, max) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) throw browserError('Browser frame dimensions must be positive integers.')
  return Math.min(value, max)
}

function number(value) {
  if (!Number.isFinite(value)) throw browserError('Browser input needs finite coordinates or deltas.')
  return value
}

// Runs inside a web page. Never copy input values into a Bot's transcript.
function readPage() {
  const items = []
  const headings = /^H([1-6])$/
  const blocks = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DIV|FOOTER|HEADER|LI|MAIN|NAV|P|PRE|SECTION|TD|TH|TR)$/
  const controls = 'a[href], button, input, select, textarea, summary, [role=button], [role=link]'
  let nodes = 0
  let chars = 0
  function walk(node) {
    if (++nodes > 30_000 || chars >= 200_000) return ''
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.data.slice(0, 200_000 - chars).replace(/\s+/g, ' ')
      chars += text.length
      return text
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches('script, style, template, noscript, input[type=hidden]')) return ''
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility !== 'visible') return ''
    if (node.tagName === 'BR') return '\n'
    const mark = node.matches(controls) && items.length < 1000 && node.getClientRects().length > 0
    const role = node.getAttribute('role') ?? ({ A: 'link', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', SUMMARY: 'button' }[node.tagName] ?? node.localName)
    const index = mark ? items.push({ role, name: (node.getAttribute('aria-label') ?? node.innerText ?? '').trim().slice(0, 200),
      ...(role === 'link' && /^https?:/i.test(node.href ?? '') ? { href: node.href.slice(0, 2000) } : {}) }) : 0
    let text = ''
    if (!node.matches('input, textarea, select, [contenteditable=true]')) {
      for (const child of (node.shadowRoot ?? node).childNodes) {
        text += walk(child)
        if (nodes >= 30_000 || chars >= 200_000) break
      }
    }
    if (index) text += ` [#${index}]`
    const heading = headings.exec(node.tagName)
    if (heading) return `\n\n${'#'.repeat(Number(heading[1]))} ${text.trim()}\n\n`
    if (node.tagName === 'LI') return `\n- ${text.trim()}`
    return blocks.test(node.tagName) ? `\n\n${text.trim()}\n\n` : text
  }
  const text = document.body ? walk(document.body).replace(/\n{3,}/g, '\n\n').trim() : ''
  return { title: document.title.slice(0, 300), url: location.href, text, items, format: 'markdown' }
}

async function launchChromium(executablePath) {
  const { chromium } = await import('playwright-core')
  return chromium.launch({ headless: true, chromiumSandbox: true, executablePath, timeout: TIMEOUT })
}

// One process, one isolated BrowserContext per Bot. Pages and their frame caches
// belong to the context, and are never looked up by tab id without a Bot id.
export function createServerBrowser({ executablePath, acceptDownloads = false, launch = () => launchChromium(executablePath) } = {}) {
  const bots = new Map()
  let browser
  let disposed = false

  function start() {
    browser ??= Promise.resolve().then(launch).then(instance => {
      instance.on('disconnected', () => {
        browser = undefined
        bots.clear()
      })
      return instance
    }).catch(error => {
      browser = undefined
      throw error
    })
    return browser
  }

  function getBot(botId) {
    if (disposed) throw browserError('The server browser is closed.', 'bot/browser-off')
    let bot = bots.get(botId)
    if (bot) return bot
    bot = { tabs: new Map(), byPage: new Map(), activeTabId: null, opening: 0 }
    bots.set(botId, bot)
    bot.context = start().then(async instance => {
      const context = await instance.newContext({ viewport: DEFAULT_VIEWPORT, acceptDownloads, serviceWorkers: 'block' })
      await context.route(url => isMetadata(url), route => route.abort())
      context.on('page', page => {
        if (bot.tabs.size >= MAX_TABS) { void page.close().catch(() => {}); return }
        track(bot, context, page)
      })
      return context
    })
      .catch(error => {
        if (bots.get(botId) === bot) bots.delete(botId)
        throw error
      })
    return bot
  }

  function track(bot, context, page) {
    const existing = bot.byPage.get(page)
    if (existing) return existing
    const id = randomUUID()
    const tab = { id, page, navEpoch: 0, loading: false, error: null, frameQueue: Promise.resolve(),
      cdp: () => tab.session ??= context.newCDPSession(page) }
    page.on('close', () => {
      bot.byPage.delete(page)
      bot.tabs.delete(id)
      if (bot.activeTabId === id) bot.activeTabId = [...bot.tabs.keys()].at(-1) ?? null
    })
    bot.byPage.set(page, tab)
    bot.tabs.set(id, tab)
    bot.activeTabId ??= id
    return tab
  }

  function selectPage(bot, page) {
    const tab = bot.byPage.get(page)
    if (tab) bot.activeTabId = tab.id
  }

  function pinPluginPage(botId) {
    const bot = bots.get(botId)
    if (bot?.pluginSession && !bot.pluginSession.closed) selectPage(bot, bot.pluginSession.pinCurrentPage())
  }

  async function openPluginSession(options) {
    const bot = getBot(options.botId)
    const context = await bot.context
    const page = bot.tabs.get(bot.activeTabId)?.page ?? await context.newPage()
    track(bot, context, page)
    // The manager owns the context. Releasing a Bot's tool session must never close owner tabs.
    bot.getHold = options.getHold
    bot.pluginSession = createSession({ ...options, context, page, sharedContext: true, validateUrl: address,
      onHold(hold, heldPage) {
        if (hold) selectPage(bot, heldPage)
        options.onHold?.(hold)
      },
    })
    return bot.pluginSession
  }

  async function state(tab) {
    const { page } = tab
    const [title, history] = await Promise.all([
      page.title().catch(() => ''),
      tab.cdp().then(session => session.send('Page.getNavigationHistory')).catch(() => undefined),
    ])
    return {
      tabId: tab.id, url: page.url(), title, loading: tab.loading,
      canGoBack: history !== undefined && history.currentIndex > 0,
      canGoForward: history !== undefined && history.currentIndex + 1 < history.entries.length,
      error: tab.error,
    }
  }

  async function navigate(tab, action) {
    const epoch = ++tab.navEpoch
    tab.loading = true
    tab.error = null
    try {
      await action()
    } catch (error) {
      if (epoch === tab.navEpoch) tab.error = String(error.message ?? error).split('\n')[0].slice(0, 400)
    } finally {
      if (epoch === tab.navEpoch) tab.loading = false
    }
    return state(tab)
  }

  async function open(botId, { url }) {
    const target = url === undefined || url === '' ? undefined : address(url)
    const bot = getBot(botId)
    if (bot.tabs.size + bot.opening >= MAX_TABS) throw browserError('This Bot has too many browser tabs.', 'bot/refused')
    bot.opening += 1
    let page
    try {
      const context = await bot.context
      if (bots.get(botId) !== bot) throw browserError('The Bot browser was closed.', 'bot/not-found')
      page = await context.newPage()
      const tab = track(bot, context, page)
      bot.activeTabId = tab.id
      return target === undefined ? state(tab) : navigate(tab, () => page.goto(target, { waitUntil: 'domcontentloaded', timeout: TIMEOUT }))
    } catch (error) {
      await page?.close().catch(() => {})
      throw error
    } finally {
      bot.opening -= 1
    }
  }

  async function input(page, body) {
    switch (body.kind) {
      case 'click': {
        const button = body.button ?? 'left'
        if (!['left', 'middle', 'right'].includes(button)) throw browserError('Unknown mouse button.')
        await page.mouse.click(number(body.x), number(body.y), { button })
        break
      }
      case 'move':
        await page.mouse.move(number(body.x), number(body.y))
        break
      case 'wheel': {
        const x = number(body.deltaX ?? 0)
        const y = number(body.deltaY ?? 0)
        if (body.x !== undefined && body.y !== undefined) await page.mouse.move(number(body.x), number(body.y))
        await page.mouse.wheel(x, y)
        break
      }
      case 'type':
        if (typeof body.text !== 'string' || body.text.length > 16_000) throw browserError('Browser input needs text of at most 16000 characters.')
        await page.keyboard.insertText(body.text)
        break
      case 'keydown':
      case 'keyup':
        if (typeof body.key !== 'string' || body.key.length > 32 || !body.key) throw browserError('Browser input needs a key.')
        if (body.kind === 'keydown') await page.keyboard.down(body.key)
        else await page.keyboard.up(body.key)
        break
      default:
        throw browserError('Unknown browser input kind.')
    }
    return { ok: true }
  }

  function frame(tab, body) {
    const viewport = tab.page.viewportSize() ?? DEFAULT_VIEWPORT
    const width = dimension(body.width, viewport.width, 1920)
    const height = dimension(body.height, viewport.height, 1080)
    // Serialize viewport changes with captures so the image and its dimensions agree.
    const work = tab.frameQueue.then(async () => {
      const { page } = tab
      const current = page.viewportSize()
      if (current?.width !== width || current?.height !== height) await page.setViewportSize({ width, height })
      const before = await state(tab)
      if (!/^https?:/i.test(before.url)) {
        tab.frame = undefined
        return { ...before, image: null, width, height, updatedAt: null }
      }
      const bytes = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 2500 })
      const hash = createHash('sha256').update(bytes).digest('hex')
      const changed = tab.frame?.hash !== hash || tab.frame.url !== before.url
      if (changed) tab.frame = { hash, url: before.url, updatedAt: Date.now() }
      return { ...await state(tab), image: changed ? bytes.toString('base64') : null, width, height, updatedAt: tab.frame.updatedAt }
    })
    tab.frameQueue = work.catch(() => {})
    return work
  }

  async function call(endpoint, botId, body) {
    if (endpoint === 'browser-tab-open') return open(botId, body)
    const bot = bots.get(botId)
    if (endpoint === 'browser-tab-list') return {
      tabs: bot ? await Promise.all([...bot.tabs.values()].map(state)) : [], activeTabId: bot?.activeTabId ?? null,
    }
    const tab = bot?.tabs.get(body.tabId)
    if (!tab) throw browserError('Unknown browser tab.', 'bot/not-found')
    const { page } = tab
    const options = { waitUntil: 'domcontentloaded', timeout: TIMEOUT }
    switch (endpoint) {
      case 'browser-tab-select': {
        bot.activeTabId = tab.id
        // The owner can browse other tabs without moving the Bot's pinned page.
        const session = bot.pluginSession
        const held = bot.getHold ? bot.getHold() : session?.hold
        if (session && !session.closed && !held) {
          const index = page.context().pages().filter(candidate => !candidate.isClosed()).indexOf(page)
          session.pinCurrentPage()
          await session.selectTab(index)
        }
        return state(tab)
      }
      case 'browser-tab-nav': {
        const url = address(body.url)
        bot.activeTabId = tab.id
        return navigate(tab, () => page.goto(url, options))
      }
      case 'browser-tab-cmd': {
        const action = { back: () => page.goBack(options), forward: () => page.goForward(options), reload: () => page.reload(options) }
        if (body.command === 'stop') {
          ++tab.navEpoch
          await (await tab.cdp()).send('Page.stopLoading')
          tab.loading = false
          tab.error = null
          return state(tab)
        }
        if (!Object.hasOwn(action, body.command)) throw browserError('Unknown browser command.')
        bot.activeTabId = tab.id
        return navigate(tab, action[body.command])
      }
      case 'browser-tab-close':
        await page.close()
        return { ok: true }
      case 'browser-tab-frame':
        // A poll for the previously visible tab can arrive after a handoff.
        return frame(tab, body)
      case 'browser-tab-input':
        bot.activeTabId = tab.id
        return input(page, body)
      default:
        throw browserError('Unknown browser endpoint.', 'bot/not-found')
    }
  }

  async function readActivePage(botId) {
    const bot = bots.get(botId)
    const page = bot?.tabs.get(bot.activeTabId)?.page
    if (!page || !/^https?:/i.test(page.url())) return undefined
    return page.evaluate(readPage)
  }

  async function drop(botId) {
    const bot = bots.get(botId)
    bots.delete(botId)
    if (bot) await bot.context.then(context => context.close(), () => {})
  }

  async function dispose() {
    disposed = true
    const running = browser
    bots.clear()
    await running?.then(instance => instance.close(), () => {})
  }

  return { call, readActivePage, openPluginSession, pinPluginPage, drop, dispose }
}
