import { createElement as h, useState } from 'react'
import { t } from './i18n.js'
import { isMac } from './settings-palette.js'
import { DEFAULT_BOT_SHORTCUTS, readBotShortcuts, sameShortcut, saveBotShortcuts, shortcutFromEvent, shortcutLabel } from './bot-shortcuts.js'

export function ShortcutsPage({ Section: ShortcutSection, Row: ShortcutRow }) {
  const [bindings, setBindings] = useState(readBotShortcuts)
  const [recording, setRecording] = useState(null)
  const [error, setError] = useState(null)
  const mac = isMac()
  const save = (next) => {
    try {
      saveBotShortcuts(next)
      setBindings(next)
      setRecording(null)
      setError(null)
    } catch { setError(t('Could not save shortcuts on this device.')) }
  }
  return h(ShortcutSection, { title: t('Bot navigation'), action: h('button', {
    type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => save(DEFAULT_BOT_SHORTCUTS),
  }, t('Reset')) },
  [['up', 'Select the Bot above'], ['down', 'Select the Bot below']].map(([id, name]) => h(ShortcutRow, {
    key: id, label: t(name), hint: recording === id ? t('Press a key combination, or Esc to cancel.') : null,
  }, h('button', {
    type: 'button', className: 'bt-soft bt-soft-sm', 'aria-label': `${t(name)}: ${shortcutLabel(bindings[id], mac)}`,
    'aria-pressed': recording === id, 'data-recording-shortcut': recording === id ? '' : undefined,
    onClick: () => { setRecording(id); setError(null) },
    onBlur: () => { if (recording === id) { setRecording(null); setError(null) } },
    onKeyDown: (event) => {
      if (recording !== id || event.repeat || event.key === 'Tab' || event.nativeEvent.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') { setRecording(null); setError(null); return }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return
      const binding = shortcutFromEvent(event.nativeEvent)
      if (!binding) { setError(t('Use a modifier with a letter, number, arrow, or function key.')); return }
      if (sameShortcut(binding, bindings[id === 'up' ? 'down' : 'up'])) { setError(t('That shortcut is already assigned to the other direction.')); return }
      save({ ...bindings, [id]: binding })
    },
  }, recording === id ? t('Recording…') : h('kbd', null, shortcutLabel(bindings[id], mac))))),
  error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null)
}
