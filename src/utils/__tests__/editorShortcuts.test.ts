import { describe, it, expect } from 'vitest'
import { createImeKeyFilter, historyShortcut, isImeKeyEvent } from '@/utils/editorShortcuts'

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

describe('createImeKeyFilter and isImeKeyEvent', () => {
  const key = (keyCode: number, timeStamp: number, isComposing = false) => ({ key: 'Enter', keyCode, timeStamp, isComposing })

  it('a key of an open composition is the input method\'s', () => {
    const filter = createImeKeyFilter()
    expect(filter.isImeKey(key(13, 10, true))).toBe(true)
    filter.compositionStart()
    const enter = key(229, 20)
    expect(filter.isImeKey(enter)).toBe(true)
    expect(isImeKeyEvent(enter)).toBe(true)
  })

  it("WebKit's committing Enter, keyCode 229 right after compositionend, is the input method's once", () => {
    const filter = createImeKeyFilter()
    filter.compositionStart()
    filter.compositionEnd({ timeStamp: 1000 })
    const commit = key(229, 1010)
    expect(filter.isImeKey(commit)).toBe(true)
    // Every handler the event reaches reads the same answer.
    expect(filter.isImeKey(commit)).toBe(true)
    expect(isImeKeyEvent(commit)).toBe(true)
    const next = key(229, 1100)
    expect(filter.isImeKey(next)).toBe(false)
    expect(isImeKeyEvent(next)).toBe(false)
  })

  it('keyCode 229 with no composition near is an ordinary key (IBus, fcitx, phone keyboards)', () => {
    const filter = createImeKeyFilter()
    const plain = key(229, 5000)
    expect(filter.isImeKey(plain)).toBe(false)
    expect(isImeKeyEvent(plain)).toBe(false)
    filter.compositionStart()
    filter.compositionEnd({ timeStamp: 6000 })
    expect(filter.isImeKey(key(229, 6500))).toBe(false)
  })

  it('a key other than 229 after compositionend is ordinary', () => {
    const filter = createImeKeyFilter()
    filter.compositionStart()
    filter.compositionEnd({ timeStamp: 1000 })
    expect(filter.isImeKey(key(13, 1010))).toBe(false)
  })

  it('a focus change forgets the composition', () => {
    const filter = createImeKeyFilter()
    filter.compositionStart()
    filter.reset()
    expect(filter.isImeKey(key(229, 10))).toBe(false)
  })
})
