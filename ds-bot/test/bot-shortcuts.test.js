import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adjacentBot, readBotShortcuts, shortcutDirection, shortcutFromEvent, shortcutLabel } from '../src/client/bot-shortcuts.js'
import { STORAGE } from '../src/client/storage.js'

const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? fileURLToPath(new URL('../dev/harness', import.meta.url)), 'package.json'))('jsdom')
const { window } = new JSDOM('', { url: 'https://example.test' })
const press = (code, modifiers) => new window.KeyboardEvent('keydown', { code, ...modifiers })

test('Option on macOS and Alt elsewhere activate the same default directions', () => {
  const bindings = readBotShortcuts(window.localStorage)
  assert.equal(shortcutLabel(bindings.up, true), '⌥↑')
  assert.equal(shortcutLabel(bindings.down, false), 'Alt+↓')
  assert.equal(shortcutDirection(press('ArrowUp', { altKey: true }), bindings), -1)
  assert.equal(shortcutDirection(press('ArrowDown', { altKey: true }), bindings), 1)
  assert.equal(shortcutDirection(press('ArrowDown', { altKey: true, shiftKey: true }), bindings), 0)
  assert.equal(shortcutDirection(press('ArrowDown', { altKey: true, isComposing: true }), bindings), 0)
  assert.equal(shortcutFromEvent(press('KeyJ', { modifierAltGraph: true, altKey: true, ctrlKey: true })), null)
  assert.equal(shortcutFromEvent(press('KeyJ', { shiftKey: true })), null)
})

test('saved shortcuts replace defaults; invalid or duplicate preferences use defaults', () => {
  const storage = window.localStorage
  const up = shortcutFromEvent(press('KeyJ', { ctrlKey: true, shiftKey: true }))
  const down = shortcutFromEvent(press('KeyK', { ctrlKey: true, shiftKey: true }))
  storage.setItem(STORAGE.botShortcuts, JSON.stringify({ up, down }))
  const saved = readBotShortcuts(storage)
  assert.equal(shortcutDirection(press('KeyK', { ctrlKey: true, shiftKey: true }), saved), 1)
  assert.equal(shortcutDirection(press('ArrowDown', { altKey: true }), saved), 0)
  for (const invalid of ['{', JSON.stringify({ up, down: up })]) {
    storage.setItem(STORAGE.botShortcuts, invalid)
    assert.equal(shortcutDirection(press('ArrowDown', { altKey: true }), readBotShortcuts(storage)), 1)
  }
  storage.clear()
})

test('Bot navigation follows the provided order and stops at the ends', () => {
  const ids = ['main', 'next', 'last']
  assert.equal(adjacentBot(ids, 'next', -1), 'main')
  assert.equal(adjacentBot(ids, 'next', 1), 'last')
  assert.equal(adjacentBot(ids, 'main', -1), undefined)
  assert.equal(adjacentBot(ids, 'last', 1), undefined)
  assert.equal(adjacentBot(ids, undefined, 1), 'main')
  assert.equal(adjacentBot(ids, undefined, -1), 'last')
  assert.equal(adjacentBot([], undefined, 1), undefined)
})
