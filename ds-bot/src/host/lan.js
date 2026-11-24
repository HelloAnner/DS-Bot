import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { BlockList } from 'node:net'
import { networkInterfaces } from 'node:os'

const PORT = 8765
const COOKIE = 'dsbot_lan'
const password = () => randomBytes(24).toString('base64url')
const same = (a, b) => typeof a === 'string' && a.length === b.length
  && Buffer.byteLength(a) === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const privateIPv4 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/
export function lanBindings(interfaces = networkInterfaces()) {
  const bindings = new Map()
  for (const entry of Object.values(interfaces).flat()) {
    if (entry?.family !== 'IPv4' || entry.internal || !entry.cidr || !privateIPv4.test(entry.address)) continue
    const prefix = Number(entry.cidr.split('/')[1])
    if (prefix < 31) {
      const bits = entry.address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0)
      const size = 2 ** (32 - prefix)
      if (bits % size === 0 || bits % size === size - 1) continue
    }
    bindings.set(entry.address, { address: entry.address, prefix })
  }
  return [...bindings.values()]
}

export function lanChat(rt, call) {
  const target = (kind, id) => {
    const item = typeof id === 'string' ? (kind === 'bot' ? rt.botOf(id) : kind === 'room' ? rt.roomOf(id) : undefined) : undefined
    return item?.private !== true && item?.id === id ? item : undefined
  }
  return async ({ action, kind, id, text, cursor }) => {
    await rt.refresh()
    if (action === 'list') return { ok: true, value: [
      ...Object.values(rt.state.bots).filter(bot => !bot.private).map(({ id, name }) => ({ kind: 'bot', id, name })),
      ...Object.values(rt.state.rooms).filter(room => !room.private).map(({ id, name }) => ({ kind: 'room', id, name })),
    ] }
    const item = target(kind, id)
    if (!item) return { ok: false, error: { message: 'Unknown conversation.' } }
    if (action === 'send' && typeof text === 'string' && text.trim() && text.length <= 16_000) {
      return call('send', { sessionId: item.id, text })
    }
    if (action !== 'read') return { ok: false, error: { message: 'Invalid chat request.' } }
    const page = await (kind === 'bot' ? call('chat', { botId: id, cursor }) : call('room-chat', { roomId: id, cursor }))
    if (!page.ok) return page
    return { ok: true, value: {
      cursor: page.value.cursor,
      items: page.value.items.filter(row => ['user', 'bot', 'post'].includes(row.kind) && typeof row.text === 'string'
        && (rt.botOf(row.botId) ?? rt.botOf(rt.selfOf?.(row.botId)))?.private !== true)
        .map(({ kind, text, name }) => ({ kind, text, name })),
    } }
  }
}

async function listen({ address, port, allowed, auth, chat, assets }) {
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => {
    void dispatch(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
  })
  server.maxConnections = 32
  server.setTimeout(10_000, socket => socket.destroy())
  const origin = () => `http://${address}:${server.address().port}`
  const reply = (res, status, body = '', contentType = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'content-type': contentType }).end(body)
  }
  async function dispatch(req, res) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    if (!allowed.check(req.socket.remoteAddress) || req.headers.host !== origin().slice(7)) return reply(res, 403)
    if (req.method === 'GET' && Object.hasOwn(assets, req.url)) {
      const [body, type] = assets[req.url]
      return reply(res, 200, body, type)
    }
    if (req.method !== 'POST' || !['/login', '/chat'].includes(req.url)) return reply(res, 404)
    if (req.headers.origin !== origin() || req.headers['content-type'] !== 'application/json') return reply(res, 403)
    const login = req.url === '/login'
    const cookies = (req.headers.cookie ?? '').split(';').map(part => part.trim())
    if (!login && !cookies.some(cookie => same(cookie, `${COOKIE}=${auth.session}`))) return reply(res, 401)
    if (login && Date.now() - auth.lastFailure < 1000) return reply(res, 429)
    const chunks = []
    let size = 0
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length
      if (size > 80_000) { res.setHeader('Connection', 'close'); return reply(res, 413) }
      chunks.push(chunk)
    }
    let body
    try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { return reply(res, 400) }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return reply(res, 400)
    if (login) {
      if (!same(body.code, auth.code)) { auth.lastFailure = Date.now(); return reply(res, 401) }
      res.setHeader('Set-Cookie', `${COOKIE}=${auth.session}; Path=/; HttpOnly; SameSite=Strict`)
      return reply(res, 204)
    }
    return reply(res, 200, JSON.stringify(await chat(body)), 'application/json; charset=utf-8')
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, address, () => { server.off('error', reject); resolve() })
  })
  return { url: `${origin()}/`, port: server.address().port, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
}

export async function startLan({ bindings, port = PORT, chat, assets }) {
  if (bindings.length === 0) throw new Error('No private LAN address found.')
  const allowed = new BlockList()
  for (const { address, prefix } of bindings) allowed.addSubnet(address, prefix)
  const auth = { code: password(), session: password(), lastFailure: 0 }
  const listeners = []
  const close = () => Promise.all(listeners.map(listener => listener.close()))
  try {
    for (const { address } of bindings) {
      const listener = await listen({ address, port, allowed, auth, chat, assets })
      listeners.push(listener)
      port = listener.port
    }
  } catch (error) {
    await close()
    throw error
  }
  return { urls: listeners.map(listener => listener.url), code: auth.code, close }
}

export function installLan(rt, call) {
  let active
  let disposed = false
  let queue = Promise.resolve()
  const view = () => ({ urls: active?.urls ?? [], code: active?.code })
  rt.ctx.effect(() => () => {
    disposed = true
    return queue.then(() => active?.close())
  }, 'ds-bot: LAN access')
  return (enabled) => {
    const next = queue.then(async () => {
      if (disposed) throw new Error('DS Bot is stopping.')
      if (enabled === undefined || enabled === Boolean(active)) return view()
      if (typeof enabled !== 'boolean') throw new Error('Invalid LAN access setting.')
      if (!enabled) {
        await active.close()
        active = undefined
      } else {
        const bindings = lanBindings()
        const assets = Object.fromEntries([
          ['/', 'lan.html', 'text/html'], ['/lan.js', 'lan-page.js', 'text/javascript'], ['/lan.css', 'lan.css', 'text/css'],
        ].map(([route, file, type]) => [route, [readFileSync(new URL(`./lan/${file}`, import.meta.url)), `${type}; charset=utf-8`]]))
        try {
          active = await startLan({ bindings, chat: lanChat(rt, call), assets })
        } catch (error) {
          if (error?.code === 'EADDRINUSE') throw new Error(`LAN port ${PORT} is in use.`)
          throw error
        }
      }
      return view()
    })
    queue = next.catch(() => {})
    return next
  }
}
