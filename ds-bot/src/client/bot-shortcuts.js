import { STORAGE } from './storage.js'

export const DEFAULT_BOT_SHORTCUTS = { up: { code: 'ArrowUp', mask: 2 }, down: { code: 'ArrowDown', mask: 2 } }
const KEY_CODE = /^(?:Key[A-Z]|Digit[0-9]|Arrow(?:Up|Down|Left|Right)|F(?:[1-9]|1[0-9]|2[0-4]))$/

export function shortcutFromEvent(event) {
  if (event.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph') || !KEY_CODE.test(event.code)) return null
  const mask = Number(event.ctrlKey) + 2 * Number(event.altKey) + 4 * Number(event.shiftKey) + 8 * Number(event.metaKey)
  return (mask & 11) === 0 ? null : { code: event.code, mask }
}

export const sameShortcut = (a, b) => a?.code === b?.code && a?.mask === b?.mask

export function readBotShortcuts(storage) {
  try {
    const saved = JSON.parse((storage ?? globalThis.localStorage).getItem(STORAGE.botShortcuts))
    const valid = binding => KEY_CODE.test(binding?.code) && Number.isInteger(binding.mask) && binding.mask > 0 && binding.mask < 16 && (binding.mask & 11) !== 0
    if (valid(saved?.up) && valid(saved?.down) && !sameShortcut(saved.up, saved.down)) return saved
  } catch { /* storage can be unavailable */ }
  return DEFAULT_BOT_SHORTCUTS
}

export function saveBotShortcuts(bindings) {
  globalThis.localStorage.setItem(STORAGE.botShortcuts, JSON.stringify(bindings))
}

export function shortcutDirection(event, bindings) {
  const pressed = shortcutFromEvent(event)
  if (sameShortcut(pressed, bindings.up)) return -1
  if (sameShortcut(pressed, bindings.down)) return 1
  return 0
}

export function shortcutLabel({ code, mask }, mac) {
  const arrows = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }
  const names = mac ? ['⌃', '⌥', '⇧', '⌘'] : ['Ctrl', 'Alt', 'Shift', 'Meta']
  return [...names.filter((_, i) => mask & (1 << i)), arrows[code] ?? code.replace(/^(Key|Digit)/, '')].join(mac ? '' : '+')
}

export function adjacentBot(ids, active, direction) {
  const at = ids.indexOf(active)
  return ids[at < 0 && direction < 0 ? ids.length - 1 : at + direction]
}
