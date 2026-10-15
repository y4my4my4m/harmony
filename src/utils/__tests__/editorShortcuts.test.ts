import { describe, it, expect } from 'vitest'
import { historyShortcut } from '@/utils/editorShortcuts'

const chord = (key: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}, code = '') => ({
  key,
  code: code || (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : ''),
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
})

describe('historyShortcut', () => {
  it('Ctrl+Z and Cmd+Z undo', () => {
    expect(historyShortcut(chord('z', { ctrl: true }))).toBe('undo')
    expect(historyShortcut(chord('z', { meta: true }))).toBe('undo')
  })

  it('Ctrl+Shift+Z redoes; Shift makes key upper case', () => {
    expect(historyShortcut(chord('Z', { ctrl: true, shift: true }))).toBe('redo')
    expect(historyShortcut(chord('Z', { meta: true, shift: true }))).toBe('redo')
    expect(historyShortcut(chord('z', { meta: true, shift: true }))).toBe('redo')
  })

  it('Ctrl+Y redoes; Ctrl+Shift+Y does not', () => {
    expect(historyShortcut(chord('y', { ctrl: true }))).toBe('redo')
    expect(historyShortcut(chord('Y', { ctrl: true, shift: true }))).toBeNull()
  })

  it('Caps Lock Ctrl+Z still undoes', () => {
    expect(historyShortcut(chord('Z', { ctrl: true }))).toBe('undo')
  })

  it('a non-Latin layout falls back to the physical key', () => {
    expect(historyShortcut(chord('я', { ctrl: true }, 'KeyZ'))).toBe('undo')
    expect(historyShortcut(chord('Я', { ctrl: true, shift: true }, 'KeyZ'))).toBe('redo')
  })

  it('a Latin layout uses the printed letter, not the physical key', () => {
    // AZERTY: the key printed Z sits where QWERTY has W.
    expect(historyShortcut(chord('z', { ctrl: true }, 'KeyW'))).toBe('undo')
    expect(historyShortcut(chord('w', { ctrl: true }, 'KeyZ'))).toBeNull()
  })

  it('ignores chords without Ctrl/Cmd or with Alt', () => {
    expect(historyShortcut(chord('z'))).toBeNull()
    expect(historyShortcut(chord('Z', { shift: true }))).toBeNull()
    expect(historyShortcut(chord('z', { ctrl: true, alt: true }))).toBeNull()
    expect(historyShortcut(chord('b', { ctrl: true }))).toBeNull()
  })
})
