import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'

export function localIPv4Addresses(interfaces = networkInterfaces()) {
  return [...new Set(Object.values(interfaces).flatMap(entries => (entries ?? [])
    .filter(({ address, family, internal }) => family === 'IPv4' && !internal && !address.startsWith('127.') && address !== '0.0.0.0')
    .map(({ address }) => address)))].sort()
}

export function resolveNetwork(values, env) {
  const host = values.host ?? env.DS_BOT_HOST ?? '127.0.0.1'
  if (!isIP(host) || host === '0.0.0.0' || host === '::') throw new Error('--host must be a concrete IP address.')
  const portText = values.port ?? env.DS_BOT_PORT ?? '3080'
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || port > 65535) throw new Error('--port must be an integer from 0 to 65535.')
  const trustedHosts = [...new Set([
    ...(env.DS_BOT_TRUSTED_HOSTS ?? '').split(/[\s,]+/), ...(env.DSH_TRUSTED_HOST ?? '').split(/[\s,]+/), ...(values['trusted-host'] ?? []),
  ].filter(Boolean))]
  const input = values['public-url']
  let publicUrl
  if (input !== undefined) {
    const invalid = () => new Error('--public-url must be an HTTP(S) URL without credentials, query, or fragment.')
    let url
    try { url = new URL(input) } catch { throw invalid() }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(url.href)) throw invalid()
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    publicUrl = url.href
  }
  return { host, port, trustedHosts, publicUrl }
}

export function networkArgs({ host, port, trustedHosts, publicUrl }) {
  return ['--host', host, '--port', String(port), ...trustedHosts.flatMap(host => ['--trusted-host', host]),
    ...(publicUrl ? ['--public-url', publicUrl] : [])]
}

export function advertisedUrl({ host, publicUrl }, boundPort) {
  if (publicUrl) return publicUrl
  const authority = isIP(host) === 6 ? `[${host.split('%')[0]}]` : host
  return new URL(`http://${authority}:${boundPort}/`).href
}
