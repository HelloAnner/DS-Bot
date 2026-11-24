import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { dump } from 'js-yaml'
import { assertServerHome } from './launchd.mjs'
import { BROWSE, serverBotEntries, serverEntries } from './profile.mjs'

const OVERLAYS = ['app-onboarding', 'goal', 'search-selector', 'office', 'server-mode']
const overlayPath = (profileDir, name) => join(dirname(profileDir), `${name}.patch.yml`)
export const serverOverlayPaths = profileDir => OVERLAYS.map(name => overlayPath(profileDir, name))

const PRESET = '@deepseek-ai/dsh-agent-preset'
const GOAL = new Set(['@deepseek-ai/dsh-command-goal', '@deepseek-ai/dsh-tool-goal'])

function withoutGoal(rows) {
  const filtered = rows.flatMap(row => {
    if (GOAL.has(row?.name)) return []
    if (!row?.group || !Array.isArray(row.config)) return [row]
    const config = withoutGoal(row.config)
    return [config === row.config ? row : { ...row, config }]
  })
  return filtered.length === rows.length && filtered.every((row, i) => row === rows[i]) ? rows : filtered
}

function goalRows(entries) {
  return entries.flatMap(({ id, name, config }) => {
    if (name !== PRESET || !Array.isArray(config?.plugins)) return []
    const plugins = withoutGoal(config.plugins)
    return plugins === config.plugins ? [] : [{ id, name, config: { ...config, plugins } }]
  })
}

function searchRows(layers, entries) {
  if (entries.find(row => row.id === 'web-search-auto')?.disabled !== true
      || entries.find(row => row.id === 'web')?.config?.searchProvider !== 'auto') return []
  const web = composeEntries(layers.filter(layer => layer.packageName !== 'ds-bot').map(layer => layer.patches))
    .find(row => row.id === 'web')
  return !web?.config?.searchProvider || web.config.searchProvider === 'auto' ? [] : [{ id: web.id, config: web.config }]
}

async function officeOverlay(runtimeDir, entries) {
  if (!runtimeDir) return {}
  const source = join(runtimeDir, 'primary-runtime')
  const node = join(source, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  const assetRoot = join(runtimeDir, 'office-skills')
  if (![join(source, 'runtime.json'), node, join(assetRoot, 'office', 'SKILL.md')].every(existsSync)) return {}
  const { Config } = await import('@deepseek-ai/dsh-skill-office')
  const config = 'pythonEnvironment' in (Config?.dict ?? {})
    ? { assetRoot, pythonEnvironment: 'workspace-dependencies' }
    : { assetRoot, node, cli: fileURLToPath(new URL('./lib/cli.js', import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))) }
  const rows = [
    { id: 'workspace-dependencies', name: '@deepseek-ai/dsh-tool-workspace-dependencies', config: { source } },
    { id: 'skill-office', name: '@deepseek-ai/dsh-skill-office', config },
  ]
  const ids = new Set(entries.map(row => row.id))
  const insert = rows.filter(row => !ids.has(row.id))
  return { node, rows: [...(insert.length ? [{ insert }] : []), ...rows.filter(row => ids.has(row.id)).map(row => ({ ...row, disabled: false }))] }
}

export async function writeServerPatches(profile, { browse, unrestricted, runtimeDir }) {
  const { layers } = profile
  const home = dirname(dirname(profile.dir))
  const entries = serverEntries(profile, home)
  const permission = entries.find(row => row.id === 'permission')
  const web = entries.find(row => row.id === 'web-runtime')
  const server = [
    ...serverBotEntries(entries, home).map(({ row, paths }) => {
      if (!row.id) throw new Error('DS Bot entries must have an id in server profiles.')
      const config = row.config ?? {}
      // Mount the same absolute paths that passed preflight, not cwd-relative inputs.
      return { id: row.id, config: { browser: true, ...config, ...paths, serverMode: true, unrestricted } }
    }),
    // The launch URL is a credential. Let DSH open it when requested, not print it into logs.
    { id: 'web-runtime', config: { ...web.config, printUrl: false } },
    ...(unrestricted ? [{ id: 'permission', config: { ...permission.config, defaultPreset: 'danger-full-access' } }] : []),
    ...(browse ? [{ id: 'directory-picker', disabled: true }, { insert: [
      { id: 'directory-picker-browse', name: BROWSE },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ] }] : []),
  ]
  const office = await officeOverlay(runtimeDir, entries)
  const overlays = {
    'app-onboarding': [{ id: 'ui-settings-models', config: { ...entries.find(row => row.id === 'ui-settings-models')?.config, credentialOnboarding: false } }],
    goal: goalRows(entries),
    'search-selector': searchRows(layers, entries),
    office: office.rows ?? [],
    'server-mode': server,
  }
  assertServerHome(dirname(profile.dir), ...serverOverlayPaths(profile.dir))
  const patchFiles = []
  for (const name of OVERLAYS) {
    const rows = overlays[name]
    if (!rows.length) continue
    const path = overlayPath(profile.dir, name)
    writeFileSync(path, dump(rows, { schema: entryListSchema }), { mode: 0o600 })
    patchFiles.push(path)
  }
  return { patchFiles, officeNode: office.node }
}
