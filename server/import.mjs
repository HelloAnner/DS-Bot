import { constants, realpathSync } from 'node:fs'
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { homedir, hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { dump, load } from 'js-yaml'
import { acquireHomeLock } from './home-lock.mjs'
import { assertServerHome, assertServerTrees, desktopLocations } from './launchd.mjs'
import { readServerProfile, serverBotEntries, serverEntries, serverProfileDir } from './profile.mjs'

const MODEL_ROWS = new Set(['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'agent-default-model', 'agent-preset-registry'])
const REGENERABLE = new Set(['node_modules', '.venv', '__pycache__', '.pnpm-store', '.next'])
const BOT_EXCLUDES = new Set(['state.lock', 'inflight.json', 'workspace', 'imported.json'])
const absent = error => error.code === 'ENOENT' || error.code === 'ENOTDIR'
const info = path => lstat(path).catch(error => { if (!absent(error)) throw error })
const contains = (root, path) => {
  const sub = relative(root, path)
  return sub !== '..' && !sub.startsWith(`..${sep}`) && !isAbsolute(sub)
}
const fold = process.platform === 'darwin' || process.platform === 'win32' ? path => path.toLowerCase() : path => path
const overlaps = (a, b) => contains(fold(a), fold(b)) || contains(fold(b), fold(a))
const segment = name => typeof name === 'string' && name !== '.' && name !== '..' && /^[^/\\:\0]+$/.test(name)
const map = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const botsIn = team => map(team?.bots) ? Object.values(team.bots).filter(map).length : 0

async function json(path, label) {
  if (!(await info(path))?.isFile()) return undefined
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error(`Could not read ${label} as JSON.`) }
}

function canonical(path) {
  try { return realpathSync.native(path) } catch (error) {
    if (!absent(error) || dirname(path) === path) throw error
    return join(canonical(dirname(path)), basename(path))
  }
}

const absolutePath = path => typeof path === 'string' && isAbsolute(path)

async function sourceTeam(explicit, to) {
  const desktop = desktopLocations()
  const saved = desktop.saved.filter(location => absolutePath(location?.dataDir))
  const candidates = [process.env.DS_BOT_HOME, ...saved.map(location => location.dataDir),
    desktop.dataDir, ...desktop.shells, join(homedir(), '.dsh')].filter(Boolean)
  for (const candidate of explicit ? [explicit] : candidates) {
    let from
    try { from = realpathSync.native(resolve(candidate)) } catch (error) {
      if (!absent(error)) throw error
      continue
    }
    if (overlaps(from, to)) {
      if (explicit) throw new Error('Import source and destination must not overlap.')
      continue
    }
    if (!(await info(join(from, 'bot')))?.isDirectory()) continue
    const team = await json(join(from, 'bot', 'state.json'), 'source Bot state')
    if (botsIn(team) === 0) continue
    const location = saved.find(location => fold(canonical(location.dataDir)) === fold(from))
    const workspace = absolutePath(location?.workspace) ? location.workspace
      : !location && fold(canonical(desktop.dataDir)) === fold(from) ? desktop.workspace : undefined
    return { from, team, workspace }
  }
  throw new Error('No Bot team found in the import source. Use --from to select a data directory.')
}

async function assertStopped(bot, label) {
  const path = join(bot, 'state.lock')
  const lock = await info(path)
  if (!lock || (lock.isFile() && Date.now() - lock.mtimeMs >= 60000)) return
  const holder = await json(path, 'Bot lock').catch(() => undefined)
  if (holder?.host === hostname() && Number.isSafeInteger(holder.pid) && holder.pid > 0) {
    try { process.kill(holder.pid, 0) } catch (error) { if (error.code === 'ESRCH') return }
  }
  throw new Error(`The ${label} Bot team may be running. Quit DS Bot or DSH before importing.`)
}

function sessionIdsOf(team) {
  const segments = parts => Array.isArray(parts) ? parts.map(part => part?.sessionId) : []
  const ids = []
  for (const bot of Object.values(team.bots ?? {})) ids.push(bot?.id, bot?.sessionId, ...segments(bot?.segments))
  for (const room of Object.values(team.rooms ?? {})) {
    ids.push(room?.id, ...Object.values(room?.sessions ?? {}), ...Object.values(room?.segments ?? {}).flatMap(segments))
  }
  return [...new Set(ids.filter(segment))]
}

// Work links are copied as files/directories only when their targets stay in the workspace.
// Other data never follows a source symlink, and no copied entry is itself a symlink.
async function copyTree(source, target, { signal, exclude, leave, workRoot, keepExisting, ancestors = new Set() }) {
  signal?.throwIfAborted()
  if (basename(source) === '.launch-url') return false
  let path = source
  try {
    let entry = await info(path)
    if (entry?.isSymbolicLink() && workRoot) {
      path = await realpath(path)
      if (basename(path) === '.launch-url' || !contains(workRoot, path) || (leave && relative(workRoot, path).split(sep).some(leave))) return false
      entry = await info(path)
    }
    const existing = keepExisting ? await info(target) : undefined
    if (existing && !(entry?.isDirectory() && existing.isDirectory())) return false
    if (entry?.isDirectory()) {
      if (ancestors.has(path)) return false
      await mkdir(target, { recursive: true, mode: 0o700 })
      const next = new Set([...ancestors, path])
      for (const name of await readdir(path)) {
        if (!exclude?.(name) && !leave?.(name)) await copyTree(join(path, name), join(target, name), { signal, leave, workRoot, keepExisting, ancestors: next })
      }
      return true
    }
    if (!entry?.isFile()) return false
    await copyFile(path, target, constants.COPYFILE_EXCL)
    return true
  } catch (error) {
    if (workRoot && ['ENOENT', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return false
    throw error
  }
}

async function copySessions(from, stage, team, signal) {
  const root = join(from, 'sessions')
  const groups = (await info(root))?.isDirectory() ? (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()) : []
  let sessions = 0
  const missingSessions = []
  for (const id of sessionIdsOf(team)) {
    let copied = false
    for (const { name } of groups) {
      const dir = join(root, name, id)
      if (!(await info(dir))?.isDirectory()) continue
      copied = await copyTree(dir, join(stage, 'sessions', name, id), { signal }) || copied
    }
    if (copied) sessions++
    else missingSessions.push(id)
  }
  return { sessions, missingSessions }
}

async function patchRows(file, destination = false) {
  const entry = await info(file)
  if (!entry) return []
  if (!entry.isFile()) throw new Error(`The ${destination ? 'destination' : 'source'} profile patch is not a regular file.`)
  try {
    const rows = load(await readFile(file, 'utf8'), { schema: entryListSchema }) ?? []
    if (Array.isArray(rows)) return rows
  } catch { /* YAML errors can quote a line containing credentials. */ }
  throw new Error(`Could not read the ${destination ? 'destination' : 'source'} profile patch as a YAML row list.`)
}

async function modelRows(from, profile) {
  const dir = join(from, 'profiles')
  const available = (await info(dir))?.isDirectory() ? (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() : []
  const names = profile ? [profile] : [...new Set(['ds-bot', 'default', ...available])]
  for (const name of names) {
    if (!available.includes(name)) continue
    const rows = await patchRows(join(dir, name, 'cordis.patch.yml')).catch(error => { if (profile) throw error; return [] })
    const selected = rows.filter(row => MODEL_ROWS.has(row?.id))
    if (selected.length) return { name, rows: selected }
  }
  return { name: null, rows: [] }
}

async function canReplaceCredentials(path) {
  try {
    const document = load(await readFile(path, 'utf8'))
    if (!map(document)) return false
    const { version, refs, records, ...rest } = document
    return (version === undefined || version === 1) && Object.keys(rest).length === 0
      && (refs === undefined || (map(refs) && Object.keys(refs).length === 0))
      && (records === undefined || (map(records) && Object.keys(records).every(key => key.startsWith('client-connection/'))))
  } catch { return false }
}

function publishPlan() {
  const dirs = new Map()
  const files = new Map()
  const conflict = target => new Error(`Import destination conflict at ${target}.`)

  async function directory(target) {
    const key = fold(target)
    if (files.has(key)) throw conflict(target)
    if (dirs.has(key)) return
    const present = await info(target)
    if (present && !present.isDirectory()) throw conflict(target)
    if (!present) await directory(dirname(target))
    dirs.set(key, { target, create: !present })
  }

  async function file(source, target, policy) {
    await directory(dirname(target))
    const key = fold(target)
    if (dirs.has(key) || files.has(key)) throw conflict(target)
    const before = await info(target)
    if (before && (!before.isFile() || policy === 'new')) throw conflict(target)
    files.set(key, { source, target, before, keep: before && policy === 'keep' })
  }

  async function tree(source, target, { keep = true, omit, freshAt = -1 } = {}) {
    if (!(await info(source))?.isDirectory()) return
    if (freshAt === 0 && await info(target)) throw conflict(target)
    await directory(target)
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (omit?.has(entry.name)) continue
      const from = join(source, entry.name)
      const to = join(target, entry.name)
      if (entry.isDirectory()) await tree(from, to, { keep, freshAt: freshAt - 1 })
      else await file(from, to, keep ? 'keep' : 'new')
    }
  }

  async function publish(stage, signal) {
    const undo = []
    try {
      for (const { target, create } of dirs.values()) {
        signal?.throwIfAborted()
        if (!create) continue
        await mkdir(target, { mode: 0o700 })
        undo.push(() => rmdir(target))
      }
      for (const { source, target, before, keep } of files.values()) {
        signal?.throwIfAborted()
        if (keep) continue
        if (before) {
          const current = await info(target)
          if (!current?.isFile() || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => current[key] !== before[key])) throw conflict(target)
          const backup = join(stage, `backup-${undo.length}`)
          await rename(target, backup)
          undo.push(() => rename(backup, target))
        }
        await link(source, target).catch(error => {
          if (error.code !== 'EXDEV') throw error
          return copyFile(source, target, constants.COPYFILE_EXCL)
        })
        undo.push(() => unlink(target))
      }
    } catch (error) {
      const failures = []
      for (const rollback of undo.reverse()) {
        try { await rollback() } catch (failure) { failures.push(failure) }
      }
      if (failures.length) throw Object.assign(new Error(`Import rollback was incomplete. Recovery files remain in ${stage}.`), { keepStage: true })
      throw error
    }
  }
  return { file, tree, publish }
}

async function assertNoLinks(...roots) {
  assertServerHome(...roots)
  // Unlike startup, import cannot follow even a safe-looking link while publishing.
  const pending = [...roots]
  while (pending.length) {
    const path = pending.pop()
    const entry = await info(path)
    if (entry?.isSymbolicLink()) throw new Error('Import destination must not contain symlinks.')
    if (entry?.isDirectory()) {
      for (const child of await readdir(path, { withFileTypes: true }).catch(error => {
        if (error.code !== 'ENOENT') throw error
        return []
      })) {
        if (child.isSymbolicLink() || child.isDirectory()) pending.push(join(path, child.name))
      }
    }
  }
  assertServerTrees(...roots)
}

function destinationBot(to, importedWorkspace, cwd = process.cwd()) {
  const oldHome = process.env.DSH_HOME
  const inherited = new Set(Object.keys(process.env))
  process.env.DSH_HOME = to
  try {
    loadLayeredEnv('dsh', cwd, () => {})
    if (process.env.DS_BOT_WORKSPACE === undefined && importedWorkspace !== undefined) process.env.DS_BOT_WORKSPACE = importedWorkspace
    let entries
    try { entries = serverEntries(readServerProfile(to), to) } catch {
      throw new Error('Could not read the destination profile patch as a YAML row list or load its bundles.')
    }
    const bots = serverBotEntries(entries, to).filter(({ row }) => row.disabled !== true)
    if (bots.length !== 1) throw new Error('Import requires exactly one enabled DS Bot entry in the destination profile.')
    return bots[0].paths
  } finally {
    for (const key of Object.keys(process.env)) if (!inherited.has(key)) delete process.env[key]
    if (oldHome !== undefined) process.env.DSH_HOME = oldHome
  }
}

export function destinationStatePath(home) {
  assertServerHome(home)
  const to = canonical(home)
  return join(destinationBot(to, undefined, to).home, 'state.json')
}

async function assertTargetBot(bot) {
  const path = join(bot, 'state.json')
  const state = await info(path)
  if (state && !state.isFile()) throw new Error('Destination Bot state is not a regular file.')
  if (botsIn(await json(path, 'destination Bot state'))) throw new Error('The destination already has a Bot team.')
  await assertStopped(bot, 'destination')
}

// Never write to the source: contents, permissions, mtime, and ctime stay intact.
// Normal reads may update atime on volumes that are not mounted noatime.
export async function importServer({ from: source, home, profile, skipWork, leaveRegenerable, signal }) {
  if (profile !== undefined && !segment(profile)) throw new Error('--profile must be a profile name.')
  assertServerHome(home)
  const to = canonical(home)
  const { from, team, workspace: desktopWork } = await sourceTeam(source, to)
  await assertNoLinks(to)
  await assertStopped(join(from, 'bot'), 'source')
  signal?.throwIfAborted()
  const models = await modelRows(from, profile)
  const { release } = acquireHomeLock(to, 'import')
  let stage
  let keepStage = false
  try {
    const sourceEnv = join(from, '.env')
    const importedWorkspace = !(await info(join(to, '.env'))) && (await info(sourceEnv))?.isFile()
      ? parseEnv(await readFile(sourceEnv, 'utf8')).DS_BOT_WORKSPACE : undefined
    const paths = destinationBot(to, importedWorkspace)
    const destBot = canonical(paths.home)
    const workspace = canonical(paths.workspace)
    if ([destBot, workspace].some(path => overlaps(from, path))) throw new Error('Import source and destination must not overlap.')
    await assertNoLinks(destBot, workspace)
    await assertTargetBot(destBot)
    stage = await mkdtemp(join(to, `.import-${Date.now()}-`))
    const oldBot = join(from, 'bot')
    const bot = join(stage, 'bot')
    await copyTree(oldBot, bot, { signal, exclude: name => BOT_EXCLUDES.has(name) || name === 'state.json' })
    const { sessions, missingSessions } = await copySessions(from, stage, team, signal)
    await copyTree(join(from, 'attachments'), join(stage, 'attachments'), { signal })
    if (!skipWork) {
      const seen = new Set()
      for (const work of [desktopWork, join(oldBot, 'workspace')].filter(Boolean)) {
        if (!(await info(work))?.isDirectory()) continue
        const workRoot = await realpath(work)
        if (seen.has(fold(workRoot))) continue
        seen.add(fold(workRoot))
        if ([to, destBot, workspace].some(path => overlaps(workRoot, path))) {
          throw new Error('Import source workspace and destination must not overlap.')
        }
        await copyTree(workRoot, join(stage, 'workspace'), { signal, workRoot, keepExisting: true,
          leave: leaveRegenerable ? name => REGENERABLE.has(name) : undefined })
      }
    }
    const keys = []
    const keptKeys = []
    const replaceKeys = new Set()
    for (const name of ['.credentials.yaml', '.env']) {
      if (!(await info(join(from, name)))?.isFile()) continue
      const target = join(to, name)
      const present = await info(target)
      if (present) {
        if (!present.isFile()) throw new Error(`Import destination conflict at ${target}.`)
        if (name !== '.credentials.yaml' || !await canReplaceCredentials(target)) {
          keptKeys.push(name)
          continue
        }
        replaceKeys.add(name)
      }
      await copyFile(join(from, name), join(stage, name), constants.COPYFILE_EXCL)
      await chmod(join(stage, name), 0o600)
      keys.push(name)
    }
    const destPatch = join(serverProfileDir(to), 'cordis.patch.yml')
    const modelPatch = join(stage, 'model.patch.yml')
    if (models.rows.length) {
      const ids = new Set(models.rows.map(row => row.id))
      const kept = (await patchRows(destPatch, true)).filter(row => !ids.has(row?.id))
      let yaml
      try { yaml = dump([...kept, ...models.rows], { schema: entryListSchema }) } catch {
        throw new Error('Could not serialize the imported model settings.')
      }
      await writeFile(modelPatch, yaml, { mode: 0o600 })
    }
    const summary = { from, at: new Date().toISOString(), bots: botsIn(team), rooms: Object.keys(team.rooms ?? {}).length,
      sessions, missingSessions, keys, keptKeys, modelSettings: models.name }
    delete team.workspaceId
    team.agents = {}
    await writeFile(join(bot, 'state.json'), JSON.stringify(team, null, 2), { mode: 0o600 })
    await writeFile(join(bot, 'imported.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
    signal?.throwIfAborted()
    await assertStopped(oldBot, 'source')
    await assertNoLinks(to, destBot, workspace)
    await assertTargetBot(destBot)
    const plan = publishPlan()
    await plan.tree(join(stage, 'sessions'), join(to, 'sessions'), { keep: false, freshAt: 2 })
    await plan.tree(join(stage, 'attachments'), join(to, 'attachments'))
    await plan.tree(bot, destBot, { omit: new Set(['state.json', 'imported.json']) })
    await plan.tree(join(stage, 'workspace'), workspace)
    for (const name of keys) await plan.file(join(stage, name), join(to, name), replaceKeys.has(name) ? 'replace' : 'new')
    if (models.rows.length) await plan.file(modelPatch, destPatch, 'replace')
    await plan.file(join(bot, 'imported.json'), join(destBot, 'imported.json'), 'replace')
    // The state becomes visible only after the rest of the team is in place.
    await plan.file(join(bot, 'state.json'), join(destBot, 'state.json'), 'replace')
    await plan.publish(stage, signal)
    return summary
  } catch (error) {
    keepStage = error.keepStage
    throw error
  } finally {
    try { if (stage && !keepStage) await rm(stage, { recursive: true, force: true }) } finally { release() }
  }
}
