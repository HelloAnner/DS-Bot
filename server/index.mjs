#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { acquireHomeLock, activeServerLock, serverProcess, serverProcessCwd } from './home-lock.mjs'
import { assertServerHome, assertServerTrees, manageAgent } from './launchd.mjs'
import { advertisedUrl, localIPv4Addresses, networkArgs, resolveNetwork } from './network.mjs'

const HELP = `Usage: ds-bot-server [start|status|stop|restart|install-agent|uninstall-agent|logs|addresses|import|copy-url|bot-state] [options]

  copy-url [--home PATH]
  bot-state [--home PATH]  Print the effective Bot state file path
  import [--from PATH] [--home PATH] [--profile NAME] [--skip-work] [--leave-regenerable]

  --home PATH           Server data (DSH_HOME, default ~/.ds-bot-server)
  --host IP             Concrete bind IP (DS_BOT_HOST, default 127.0.0.1)
  --port NUMBER         HTTP port (DS_BOT_PORT, default 3080; 0 picks a free port)
  --loopback            Also listen on 127.0.0.1 on the same port
  --trusted-host HOST   Extra browser authority; repeat to add more
  --public-url URL      Browser-facing URL behind a reverse proxy
  --restricted          Keep configured DSH permission defaults
  --runtime-dir PATH    Optional Office runtime (DS_BOT_RUNTIME_DIR)
  --open                Open the browser at startup
  --copy-url            Copy the authenticated URL to the macOS clipboard (start only)
  --plist-dir PATH      Override the LaunchAgent plist directory
  --stop-foreground     Also stop a foreground server in --home (stop/uninstall-agent)
  --dry-run             Print the LaunchAgent action without running it
`

const commands = ['start', 'status', 'stop', 'restart', 'install-agent', 'uninstall-agent', 'logs', 'addresses', 'import', 'copy-url', 'bot-state', 'help']
const cliOptions = {
  from: { type: 'string' }, profile: { type: 'string' }, 'skip-work': { type: 'boolean' }, 'leave-regenerable': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' }, home: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' },
  loopback: { type: 'boolean' }, 'trusted-host': { type: 'string', multiple: true }, 'public-url': { type: 'string' },
  restricted: { type: 'boolean' }, 'runtime-dir': { type: 'string' }, open: { type: 'boolean' }, 'copy-url': { type: 'boolean' },
  'plist-dir': { type: 'string' }, 'dry-run': { type: 'boolean' }, 'stop-foreground': { type: 'boolean' },
}

export function parseOptions(argv, env = process.env) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: cliOptions })
  const [command = 'start'] = positionals
  if (values.help || command === 'help') return { command: 'help' }
  if (positionals.length > 1 || !commands.includes(command)) {
    throw new Error('Unknown command. See --help.')
  }
  const importFlags = ['from', 'profile', 'skip-work', 'leave-regenerable']
  if (command === 'import') {
    if (Object.keys(values).some(key => key !== 'home' && !importFlags.includes(key))) throw new Error('Invalid option for import. See --help.')
    if (values.from === '' || values.home === '') throw new Error('Import paths must not be empty.')
    return { command, home: resolve(values.home ?? join(homedir(), '.ds-bot-server')), from: values.from,
      profile: values.profile, skipWork: values['skip-work'], leaveRegenerable: values['leave-regenerable'] }
  }
  if (importFlags.some(key => values[key] !== undefined)) throw new Error('Import options require the import command.')
  const home = resolve(values.home ?? env.DSH_HOME ?? join(homedir(), '.ds-bot-server'))
  if (command === 'copy-url' || command === 'bot-state') {
    if (Object.keys(values).some(key => key !== 'home') || values.home === '') throw new Error(`Invalid option for ${command}. See --help.`)
    return { command, home }
  }
  if (values['stop-foreground'] && !['stop', 'uninstall-agent'].includes(command)) throw new Error('--stop-foreground requires stop or uninstall-agent.')
  if (values['copy-url'] && (command !== 'start' || process.platform !== 'darwin')) throw new Error('--copy-url requires start on macOS.')
  if (values['dry-run'] && ['start', 'logs', 'addresses'].includes(command)) throw new Error('--dry-run is only for LaunchAgent actions.')
  const runtimeDir = values['runtime-dir'] ?? env.DS_BOT_RUNTIME_DIR
  return { command, home, network: resolveNetwork(values, env),
    unrestricted: !values.restricted && env.DS_BOT_UNRESTRICTED !== '0', runtimeDir: runtimeDir ? resolve(runtimeDir) : undefined,
    loopback: values.loopback, open: values.open, copyUrl: values['copy-url'], plistDir: values['plist-dir'], stopForeground: values['stop-foreground'], dryRun: values['dry-run'] }
}

function startArgs(options) {
  return ['start', '--home', options.home, ...networkArgs(options.network),
    ...(options.loopback ? ['--loopback'] : []),
    ...(options.runtimeDir ? ['--runtime-dir', options.runtimeDir] : []),
    ...(options.unrestricted ? [] : ['--restricted']), ...(options.open ? ['--open'] : [])]
}

const launchUrlPath = home => join(home, '.launch-url')

function publishLaunchUrl(path, url) {
  const pending = `${path}-${randomUUID()}`
  try {
    const fd = openSync(pending, 'wx', 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeFileSync(fd, url)
    } finally {
      closeSync(fd)
    }
    renameSync(pending, path)
  } finally {
    rmSync(pending, { force: true })
  }
}

function sendToClipboard(url) {
  const result = spawnSync(process.env.DS_BOT_PBCOPY || '/usr/bin/pbcopy', [], {
    input: url, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000,
  })
  if (result.status !== 0) throw new Error('Could not copy the launch URL. Use the clipboard in a signed-in macOS session.')
  console.log('Copied the authenticated launch URL to your clipboard.')
}

function copyUrl(home) {
  const path = launchUrlPath(home)
  assertServerHome(home, path)
  const lock = activeServerLock(home)
  if (!lock) throw new Error('The server is not running in this home. Start it before copying the URL.')
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('The server is not ready. Try again once startup completes.')
    if (error.code === 'ELOOP') throw new Error('The launch URL must be a private regular file owned by you.')
    throw error
  }
  let url
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()) {
      throw new Error('The launch URL must be a private regular file owned by you.')
    }
    url = readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
  if (!url) throw new Error('The launch URL file is empty.')
  if (activeServerLock(home)?.name !== lock.name) throw new Error('The server stopped or restarted. Try again once startup completes.')
  sendToClipboard(url)
}

async function start(options) {
  const { home, release } = acquireHomeLock(options.home, 'server')
  const path = launchUrlPath(home)
  const removeUrl = () => rmSync(path, { force: true })
  // DSH owns shutdown once it mounts. Keep the lock until process exit,
  // after normal DSH disposal, rather than releasing it at readiness.
  const cleanup = () => { try { removeUrl() } finally { release() } }
  process.once('exit', cleanup)
  const controller = new AbortController()
  const interrupt = signal => {
    controller.abort(new Error(`Startup interrupted by ${signal}.`))
    removeUrl()
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  try {
    removeUrl() // A previous process may have been killed before cleaning up.
    await boot({ ...options, home }, controller.signal)
  } catch (error) {
    process.off('exit', cleanup)
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    cleanup()
    throw error
  }
}

// Forward the byte stream so DSH handles HTTP, WebSocket, and authentication
// identically on both addresses. One DSH instance still owns all sessions.
export async function listenLoopback(host, port, signal) {
  const clients = new Set()
  const listener = createServer(client => {
    const upstream = connect({ host, port })
    clients.add(client)
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
    client.once('close', () => { clients.delete(client); upstream.destroy() })
    upstream.once('close', () => client.end())
    client.pipe(upstream).pipe(client)
  })
  const close = () => {
    listener.close()
    for (const client of clients) client.destroy()
  }
  await new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(port, '127.0.0.1', () => {
      listener.off('error', reject)
      resolve()
    })
  })
  if (signal.aborted) close()
  else signal.addEventListener('abort', close, { once: true })
  signal.throwIfAborted()
  return listener
}

async function boot(options, signal) {
  process.env.DSH_HOME = options.home
  process.env.DS_BOT_SERVER = '1'
  process.env.DS_BOT_UNRESTRICTED = options.unrestricted ? '1' : '0'
  delete process.env.DS_BOT_APP
  const { loadLayeredEnv, reportSkippedBundles } = await import('@deepseek-ai/dsh-app-boot')
  const { runProfile } = await import('@deepseek-ai/dsh/profile-boot')
  const { PROFILE, INSTALL_ANCHOR, botDataPaths, browseAvailable, loadServerProfile, serverProfileDir } = await import('./profile.mjs')
  const { serverOverlayPaths, writeServerPatches } = await import('./patches.mjs')
  signal.throwIfAborted()
  assertServerHome(options.home, ...serverOverlayPaths(serverProfileDir(options.home)))
  assertServerTrees(options.home)
  const environment = loadLayeredEnv('dsh')
  botDataPaths(options.home, { workspace: join(options.home, 'bot', 'workspace') })
  const profile = loadServerProfile(options.home)
  reportSkippedBundles('dsh', profile)
  const { patchFiles, officeNode } = await writeServerPatches(profile, { ...options, browse: browseAvailable() })
  if (officeNode !== undefined) process.env.DS_BOT_OFFICE_NODE = officeNode
  signal.throwIfAborted()
  const { ctx, shutdown } = await runProfile({
    environment, profile: PROFILE, resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR }, patchFiles,
    args: [...networkArgs(options.network), '--no-open'],
  })
  try {
    signal.throwIfAborted()
    const webServer = ctx.get('webServer')
    const connection = ctx.get('connection')
    if (!webServer || !connection || !ctx.get('sessionController') || !ctx.get('workspaceRegistry')) {
      throw new Error('The server profile did not start the required web and session services.')
    }
    if (options.loopback && options.network.host !== '127.0.0.1') {
      await listenLoopback(options.network.host, webServer.port, signal)
    }
    const url = advertisedUrl(options.network, webServer.port)
    const launchUrl = connection.authenticatedUrl(url)
    publishLaunchUrl(launchUrlPath(options.home), launchUrl)
    if (options.copyUrl) sendToClipboard(launchUrl)
    if (options.open) openBrowser(launchUrl)
    if (process.connected) process.send({ type: 'ready', url: launchUrl })
    console.log(`DS Bot Server ready at ${url}`)
  } catch (error) {
    await shutdown.shutdown(1)
    throw error
  }
}

function openBrowser(url) {
  // The OS opener can include the URL in its errors. Do not forward its output.
  const [command, ...args] = process.platform === 'darwin' ? ['/usr/bin/open']
    : process.platform === 'win32' ? ['rundll32.exe', 'url.dll,FileProtocolHandler'] : ['xdg-open']
  const result = spawnSync(command, [...args, url], { stdio: 'ignore', timeout: 5000 })
  if (result.status !== 0) console.error('Could not open the browser. Use copy-url on macOS to sign in.')
}

async function migrate(options) {
  const controller = new AbortController()
  const stop = () => controller.abort(new Error('Import interrupted.'))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    const { importServer } = await import('./import.mjs')
    const result = await importServer({ ...options, signal: controller.signal })
    console.log(`Imported ${result.bots} bot(s), ${result.rooms} room(s), ${result.sessions} session(s) (${result.missingSessions.length} missing).`)
    console.log(`Credential files copied: ${result.keys.length}; kept: ${result.keptKeys.length}. Model settings: ${result.modelSettings ? 'copied' : 'none'}.`)
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

function matchesHome(candidate, homes, cwd) {
  if (homes.has(candidate)) return true
  if (!cwd) return false
  const path = resolve(cwd, candidate)
  if (homes.has(path)) return true
  try { return homes.has(realpathSync.native(path)) } catch { return false }
}

function psCliArgs(args, homes, cwd) {
  const knownHomes = new Set(homes.filter(Boolean))
  const words = [...args.matchAll(/\S+/gu)]
  const argv = []
  for (let i = 0; i < words.length; i++) {
    const [word] = words[i]
    argv.push(word)
    if (word === '--') return [...argv, ...words.slice(i + 1).map(([value]) => value)]
    if (!word.startsWith('--')) continue
    const [flag, inline] = word.split('=', 2)
    if (!Object.hasOwn(cliOptions, flag.slice(2)) || cliOptions[flag.slice(2)].type !== 'string') continue
    if (inline === undefined && (!words[i + 1] || words[i + 1][0].startsWith('-'))) continue
    const first = inline === undefined ? ++i : i
    const valueStart = inline === undefined ? words[first].index : words[first].index + flag.length + 1
    if (flag === '--home' && knownHomes.size) {
      let last = first
      while (words[last + 1] && !words[last + 1][0].startsWith('-')) last++
      // Try the longest span first, including command-like words in a known home.
      for (; last >= first; last--) {
        const candidate = args.slice(valueStart, words[last].index + words[last][0].length)
        if (candidate && matchesHome(candidate, knownHomes, cwd)) break
      }
      if (last >= first) {
        i = last
        const home = args.slice(valueStart, words[i].index + words[i][0].length)
        if (inline === undefined) argv.push(home)
        else argv[argv.length - 1] = `${flag}=${home}`
        continue
      }
    }
    // Without a known value, leave command words separate rather than guessing.
    while (words[i + 1] && !words[i + 1][0].startsWith('-') && !commands.includes(words[i + 1][0])) i++
    const value = args.slice(words[first].index, words[i].index + words[i][0].length)
    if (inline === undefined) argv.push(value)
    else argv[argv.length - 1] = value
  }
  return argv
}

export function isServerStart(command, homes = [], cwd) {
  const entry = fileURLToPath(import.meta.url)
  const nodeArgs = command.match(/^(?:node|\/[^\n]*?\/node) +(.*)$/u)?.[1]
  if (nodeArgs === undefined) return false
  const invocation = nodeArgs.replace(/^(?:--(?!(?:eval|print)(?:=| |$))[^\s]+ +)*/u, '')
  let args
  if (invocation === entry || invocation.startsWith(`${entry} `)) args = invocation.slice(entry.length)
  else {
    const match = invocation.match(/^((?:.*?\/)?server\/index\.mjs)(?= |$)(.*)$/u)
    // Do not mistake a later script argument for the entry point.
    if (!match || /(?:^| )-|\.(?:[cm]?js) /u.test(match[1])) return false
    args = match[2]
  }
  try {
    return parseOptions(psCliArgs(args, homes, cwd), {}).command === 'start'
  } catch {
    return false
  }
}

export async function stopForeground(home, managedPid) {
  const lock = activeServerLock(home)
  if (!lock) return
  if (lock.pid !== managedPid) {
    const holder = serverProcess(lock.pid)
    if (!holder && !activeServerLock(home)) return
    const homes = [...new Set([resolve(home), realpathSync.native(home)])]
    if (!holder || holder.uid !== process.getuid()
      || (lock.started && holder.started !== lock.started)
      || !isServerStart(holder.command, homes, serverProcessCwd(lock.pid))) {
      throw new Error('Could not verify the server lock belongs to a DS Bot process. No signal was sent.')
    }
    try { process.kill(lock.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const current = activeServerLock(home)
    if (current && current.name !== lock.name) throw new Error('Another server started while stopping this home.')
    try { process.kill(lock.pid, 0) } catch (error) {
      if (error.code === 'ESRCH' && !current) return
      if (error.code !== 'ESRCH') throw error
    }
    await delay(100)
  }
  throw new Error('The server did not exit within 15 seconds. No replacement was started.')
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const { command } = options
  if (command === 'help') return console.log(HELP)
  if (command === 'start') return start(options)
  if (command === 'import') return migrate(options)
  if (command === 'copy-url') return copyUrl(options.home)
  if (command === 'bot-state') {
    const { destinationStatePath } = await import('./import.mjs')
    return console.log(destinationStatePath(options.home))
  }
  if (command === 'status' && !options.dryRun) {
    const lock = activeServerLock(options.home)
    if (lock) console.log(`Server running in this home (PID ${lock.pid}).`)
  }
  if (command === 'addresses') {
    const addresses = localIPv4Addresses()
    return console.log(addresses.join('\n') || 'No non-loopback IPv4 addresses found.')
  }
  const args = [process.execPath, fileURLToPath(import.meta.url), ...startArgs(options)]
  let managedPid
  console.log(manageAgent(command, { ...options, args, path: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    onBootout: pid => { managedPid = pid } }))
  if (options.stopForeground && !options.dryRun) await stopForeground(options.home, managedPid)
}

if (import.meta.main) main().catch(error => {
  console.error(`ds-bot-server: ${error.message}`)
  process.exitCode = 1
})
