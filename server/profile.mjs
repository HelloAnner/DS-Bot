import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBundlePlatform, bundlePatchPaths, composeEntries, evaluatePluginCompatibility, initProfile, loadOptionalPatches, loadOverlayPatches, loadProfileDirectory, PROFILE_PATCH_FILENAME, readProfileManifest, readProfileVersionExemptions, resolveBundleDir, resolveProfileDir, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'
import { PROFILE_ROOT_FILENAME } from '@deepseek-ai/dsh/profile-boot'
import { assertServerHome, assertServerTrees } from './launchd.mjs'

export const PROFILE = 'ds-bot-server'
export const INSTALL_ANCHOR = fileURLToPath(new URL('./package.json', import.meta.url))
export const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-voice-input-bundle', 'ds-bot']
export const BROWSE = '@deepseek-ai/dsh-host-directory-picker-browse'

export const serverProfileDir = home => resolveProfileDir(PROFILE, home)

const defaultBotHome = home => join(home, 'bot')

export function botDataPaths(home, config = {}) {
  if (typeof config !== 'object' || Array.isArray(config) || Object.hasOwn(config, '__jsExpr')) {
    throw new Error('DS Bot config must be a mapping with literal home and workspace paths.')
  }
  const path = (value, fallback, name) => {
    if (value == null) return fallback
    if (typeof value !== 'string' || !value.trim()) throw new Error(`DS Bot ${name} must be a literal path.`)
    return resolve(home, value)
  }
  const botHome = path(config.home, defaultBotHome(home), 'home')
  const workspace = path(config.workspace ?? (process.env.DS_BOT_WORKSPACE?.trim() || undefined), join(botHome, 'workspace'), 'workspace')
  assertServerHome(botHome, join(botHome, 'state.json'), join(botHome, 'state.lock'), join(botHome, 'workspace'), workspace)
  assertServerTrees(botHome, workspace)
  return { home: botHome, workspace }
}

function* botRows(entries) {
  for (const row of entries) {
    if (row.name === 'ds-bot') yield row
    if (row.group && Array.isArray(row.config)) yield* botRows(row.config)
  }
}

export function serverEntries(profile, home = dirname(dirname(profile.dir))) {
  const homePatches = loadOptionalPatches('dsh', join(home, PROFILE_PATCH_FILENAME)) ?? []
  return composeEntries([...profile.layers.map(layer => layer.patches), profile.patches, homePatches])
}

export function serverBotEntries(entries, home) {
  return [...botRows(entries)].map(row => ({ row, paths: botDataPaths(home, row.config ?? {}) }))
}

// Inspect the destination without initializing or rewriting its profile.
export function readServerProfile(home) {
  const dir = serverProfileDir(home)
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  const manifest = existsSync(join(dir, 'package.json')) ? readProfileManifest('dsh', dir) : undefined
  const bundles = new Set([...BUNDLES, ...(manifest?.dsh?.profile?.bundles ?? [])])
  const exemptions = readProfileVersionExemptions(dir)
  const layers = []
  for (const packageName of bundles) {
    try {
      const packageDir = resolveBundleDir('dsh', packageName, INSTALL_ANCHOR, dir)
      const manifest = readProfileManifest('dsh', packageDir)
      const bundle = manifest.dsh.bundle
      assertBundlePlatform(bundle.platforms, process.platform)
      const issue = evaluatePluginCompatibility(manifest, exemptions)
      if (issue && !issue.exempted) throw new Error('Incompatible profile bundle.')
      layers.push({ packageName, patches: bundlePatchPaths(packageDir, bundle).flatMap(path => loadOverlayPatches('dsh', path)) })
    } catch (error) {
      if (BUNDLES.includes(packageName)) throw error
    }
  }
  return { dir, layers, patches: loadOptionalPatches('dsh', patchPath) ?? [] }
}

export function loadServerProfile(home) {
  const dir = serverProfileDir(home)
  assertServerHome(home, dirname(dir), dir, join(home, PROFILE_PATCH_FILENAME),
    ...['package.json', PROFILE_PATCH_FILENAME, 'pnpm-workspace.yaml', PROFILE_ROOT_FILENAME, 'node_modules'].map(name => join(dir, name)))
  mkdirSync(home, { recursive: true, mode: 0o700 })
  initProfile(dir, BUNDLES)
  const manifest = readProfileManifest('dsh', dir)
  const listed = manifest.dsh?.profile?.bundles ?? []
  const bundles = [...BUNDLES, ...listed.filter(name => !BUNDLES.includes(name))]
  if (bundles.some((name, index) => name !== listed[index])) writeProfileBundles(dir, manifest, bundles)
  const profile = loadProfileDirectory('dsh', dir, INSTALL_ANCHOR)
  const missing = profile.skippedBundles.filter(({ packageName }) => BUNDLES.includes(packageName))
  if (missing.length > 0) throw new Error(`Required bundles did not load: ${missing.map(({ packageName, reason }) => `${packageName}: ${reason}`).join('; ')}`)
  return profile
}

export function browseAvailable() {
  try {
    import.meta.resolve(BROWSE)
    return true
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    return false
  }
}
