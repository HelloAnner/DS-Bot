import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertServerHome } from './launchd.mjs'

const messages = {
  import: 'An import is already in progress in the destination.',
  server: 'A server is already running in the destination.',
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}

function inspect(path) {
  const dir = lstatSync(path, { throwIfNoEntry: false })
  if (!dir) return []
  if (!dir.isDirectory()) return undefined
  try {
    return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/u.test(entry.name)) return [undefined]
      try {
        const { pid, started } = JSON.parse(readFileSync(join(path, entry.name), 'utf8'))
        return [Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff ? { name: entry.name, pid, started } : undefined]
      } catch (error) {
        return error.code === 'ENOENT' ? [] : [undefined]
      }
    })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return []
  }
}

function removeRecord(path, name) {
  try { unlinkSync(join(path, name)) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function removeEmpty(path) {
  try { rmdirSync(path) } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
  }
}

export function serverProcess(pid) {
  const result = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'command='], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },
  })
  const match = result.stdout?.trim().match(/^(\d+)\s+(.{24})\s+(.+)$/u)
  if (result.status !== 0 || !match) return undefined
  return { uid: Number(match[1]), started: match[2], command: match[3] }
}

export function serverProcessCwd(pid) {
  if (process.platform !== 'darwin') return undefined
  const result = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8', timeout: 2000,
  })
  if (result.status !== 0) return undefined
  return result.stdout.match(/^n(\/[^\n]+)$/mu)?.[1]
}

function recordAlive(record) {
  if (!pidAlive(record.pid)) return false
  if (!record.started) return true
  const holder = serverProcess(record.pid)
  // If ps cannot verify the identity, do not reap a possibly live lock.
  return !holder || holder.started === record.started
}

export function activeServerLock(home) {
  const path = join(home, '.server.lock')
  assertServerHome(home, path)
  const records = inspect(path)
  if (!records || records.some(record => !record) || records.length > 1) throw new Error('Invalid server lock.')
  const [record] = records
  return record && recordAlive(record) ? record : undefined
}

export function acquireHomeLock(home, kind) {
  assertServerHome(home, join(home, '.server.lock'), join(home, '.import.lock'))
  mkdirSync(home, { recursive: true, mode: 0o700 })
  home = realpathSync.native(home)
  const path = join(home, `.${kind}.lock`)
  const other = kind === 'server' ? 'import' : 'server'
  const name = `${randomUUID()}.json`
  const pending = mkdtempSync(`${path}-`)
  try {
    const started = kind === 'server' && process.platform === 'darwin' ? serverProcess(process.pid)?.started : undefined
    writeFileSync(join(pending, name), JSON.stringify({ pid: process.pid, started }), { mode: 0o600 })
    for (;;) {
      const records = inspect(path)
      if (!records || records.some(record => !record || recordAlive(record))) throw new Error(messages[kind])
      // Reap only the dead owner's uniquely named record. A late reaper cannot
      // remove a successor's record, and rmdir cannot remove a populated lock.
      for (const record of records) removeRecord(path, record.name)
      if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) removeEmpty(path)
      try {
        // Rename publishes the complete PID record; it cannot replace a nonempty directory.
        renameSync(pending, path)
        break
      } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(error.code) || !lstatSync(path, { throwIfNoEntry: false })) throw error
      }
    }
  } finally {
    rmSync(pending, { recursive: true, force: true })
  }
  const release = () => {
    removeRecord(path, name)
    removeEmpty(path)
  }
  try {
    // Both commands publish their own lock before observing the other one.
    const records = inspect(join(home, `.${other}.lock`))
    if (!records || records.some(record => !record || recordAlive(record))) throw new Error(messages[other])
    return { home, release }
  } catch (error) {
    release()
    throw error
  }
}
