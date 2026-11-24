import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const LABEL = 'io.github.fei2411.dsbot-server'
const xml = value => {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) throw new Error('Invalid XML control character in LaunchAgent configuration.')
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char])
}
const string = value => `<string>${xml(value)}</string>`

// Resolve the nearest existing parent too, before mkdir can follow a symlink.
function canonicalPath(path) {
  try { return realpathSync(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const link = lstatSync(path, { throwIfNoEntry: false })
    if (link?.isSymbolicLink()) throw new Error('Cannot use a dangling symlink for a server path.')
    const parent = dirname(path)
    if (parent === path) throw error
    return join(canonicalPath(parent), basename(path))
  }
}

const inside = (root, path) => {
  const from = relative(root, path)
  return from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from)
}

function fileIdentity(path) {
  const info = statSync(path, { bigint: true, throwIfNoEntry: false })
  return info && `${info.dev}:${info.ino}`
}

function hasProtectedAncestor(path, ids) {
  for (;;) {
    if (ids.has(fileIdentity(path))) return true
    const parent = dirname(path)
    if (parent === path) return false
    path = parent
  }
}

export function desktopLocations() {
  const home = homedir()
  const { APPDATA, XDG_CONFIG_HOME, DS_BOT_SHELL_DATA } = process.env
  const appData = process.platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : process.platform === 'win32' ? APPDATA || join(home, 'AppData', 'Roaming') : XDG_CONFIG_HOME || join(home, '.config')
  const shells = [DS_BOT_SHELL_DATA, join(appData, 'DS Bot'), join(appData, 'DeepSeek Bot')].filter(Boolean)
  const saved = []
  for (const shell of shells) {
    let text
    try { text = readFileSync(join(shell, 'locations.json'), 'utf8') } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue
      throw error
    }
    try { saved.push(JSON.parse(text)) } catch { throw new Error('Could not read desktop locations as JSON.') }
  }
  return { shells, saved, dataDir: join(home, '.ds-bot'), workspace: join(home, 'DS Bot') }
}

function protectedPaths() {
  const { shells, saved, dataDir, workspace } = desktopLocations()
  const paths = [join(homedir(), '.dsh'), dataDir, workspace, process.env.DS_BOT_HOME, ...shells]
  for (const location of saved) {
    for (const path of [location?.dataDir, location?.workspace]) {
      if (typeof path === 'string' && isAbsolute(path)) paths.push(path)
    }
  }
  return paths.filter(Boolean).map(path => resolve(path))
}

function serverPathGuard() {
  const roots = protectedPaths().map(path => ({ path, canonical: canonicalPath(path), id: fileIdentity(path) }))
  const ids = new Set(roots.flatMap(({ id }) => id === undefined ? [] : [id]))
  // Reserve the protected names on macOS and Windows even before they exist.
  const fold = process.platform === 'darwin' || process.platform === 'win32' ? path => path.toLowerCase() : path => path
  return path => {
    const absolute = resolve(path)
    const canonical = canonicalPath(absolute)
    if (roots.some(root => inside(fold(root.path), fold(absolute)) || inside(fold(root.canonical), fold(canonical)))
      || hasProtectedAncestor(absolute, ids) || (canonical !== absolute && hasProtectedAncestor(canonical, ids))) {
      throw new Error('Choose server paths outside ~/.dsh and the desktop app data directory.')
    }
    return canonical
  }
}

export function assertServerHome(home, ...files) {
  const check = serverPathGuard()
  for (const path of [home, ...files]) check(path)
}

export function assertServerTrees(...roots) {
  const check = serverPathGuard()
  const visited = new Set()
  const pending = [...roots]
  while (pending.length) {
    const dir = check(pending.pop())
    const info = statSync(dir, { throwIfNoEntry: false })
    if (!info?.isDirectory() || visited.has(dir)) continue
    visited.add(dir)
    // Scan ordinary descendants and safe linked directories, without following a cycle.
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) pending.push(join(dir, entry.name))
    }
  }
}

export function agentFiles(home, plistDir = join(homedir(), 'Library', 'LaunchAgents')) {
  return { plist: join(plistDir, `${LABEL}.plist`), log: join(home, 'server.log') }
}

export function agentPlist({ args, home, log, path }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${string(LABEL)}
  <key>ProgramArguments</key><array>${args.map(string).join('')}</array>
  <key>WorkingDirectory</key>${string(home)}
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key>${string(path)}
    <key>DS_BOT_SUPERVISED</key><string>1</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${string(log)}
  <key>StandardErrorPath</key>${string(log)}
</dict>
</plist>
`
}

export function manageAgent(action, { home, plistDir, args, path, dryRun, run, onBootout, platform = process.platform }) {
  const { plist, log } = agentFiles(home, plistDir)
  assertServerHome(home, ...(action === 'logs' ? [log] : action === 'install-agent' ? [plist, log] : [plist]))
  const domain = `gui/${process.getuid?.()}`
  const target = `${domain}/${LABEL}`
  const launchctl = run ?? ((...args) => execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  if (action === 'logs') return readFileSync(log, 'utf8').replace(/([?&]token=)[^\s"'<>]+/gi, '$1[redacted]')
  const content = action === 'install-agent' ? agentPlist({ args, home, log, path }) : undefined
  if (dryRun) return content ?? `Would ${action} ${target} (${plist}).`
  if (platform !== 'darwin') throw new Error('LaunchAgent management requires macOS. Run start in the foreground on this platform.')
  const state = () => {
    try { return launchctl('print', target) } catch (error) {
      if (error.status === 113 || error.status === 3) return undefined
      throw error
    }
  }
  if (action === 'status') return state() ?? (existsSync(plist) ? 'LaunchAgent installed, not loaded.' : 'LaunchAgent not installed.')
  if (action === 'install-agent') {
    if (existsSync(plist)) throw new Error('LaunchAgent already installed. Uninstall it before changing its configuration.')
    mkdirSync(dirname(plist), { recursive: true })
    mkdirSync(home, { recursive: true, mode: 0o700 })
    writeFileSync(log, '', { flag: 'a', mode: 0o600 })
    writeFileSync(plist, content, { flag: 'wx', mode: 0o600 })
    try { launchctl('bootstrap', domain, plist) } catch (error) {
      rmSync(plist)
      throw error
    }
    return `Installed ${plist}`
  }
  if (action === 'restart') {
    if (!state()) launchctl('bootstrap', domain, plist)
    else launchctl('kill', 'SIGTERM', target)
    return 'LaunchAgent restart requested.'
  }
  const loaded = state()
  if (loaded) {
    const pid = Number(loaded.match(/^\s*pid = (\d+)$/mu)?.[1])
    launchctl('bootout', target)
    onBootout?.(pid)
  }
  if (action === 'uninstall-agent') rmSync(plist, { force: true })
  return action === 'stop' ? 'LaunchAgent stopped.' : 'LaunchAgent uninstalled.'
}
