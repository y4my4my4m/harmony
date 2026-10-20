import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachTapToCaret, isAndroidUserAgent, keyboardLikelyOpen, wordBounds } from '../tapToCaret'

// A tap in a focused editor on Android moves the caret without Chromium's tap handling (and
// its spelling menu); a tap in the caret's own word, a long press, a drag, or any tap with
// the keyboard down runs natively. The menu itself was checked on an API 35 emulator with Gboard.

let editor: HTMLDivElement
let text: Text
let keyboard = true
let detach: () => void

function touchEvent(type: 'touchstart' | 'touchend', x: number, y: number, timeStamp: number) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const touch = { clientX: x, clientY: y }
  Object.defineProperty(event, 'touches', { value: type === 'touchstart' ? [touch] : [] })
  Object.defineProperty(event, 'changedTouches', { value: [touch] })
  Object.defineProperty(event, 'timeStamp', { value: timeStamp })
  return event
}

/** A tap at character `offset`: caretRangeFromPoint answers that offset. */
function tap(offset: number, opts: { moveBy?: number; holdMs?: number; node?: Node } = {}) {
  const node = opts.node ?? text
  document.caretRangeFromPoint = vi.fn(() => {
    const range = document.createRange()
    range.setStart(node, offset)
    return range
  })
  editor.dispatchEvent(touchEvent('touchstart', 100, 100, 1000))
  const end = touchEvent('touchend', 100 + (opts.moveBy ?? 0), 100, 1000 + (opts.holdMs ?? 80))
  editor.dispatchEvent(end)
  return end.defaultPrevented
}

function caretAt(offset: number) {
  getSelection()!.collapse(text, offset)
}

beforeEach(() => {
  editor = document.createElement('div')
  editor.contentEditable = 'true'
  text = document.createTextNode('this is a misspeled word')
  editor.append(text)
  document.body.append(editor)
  editor.focus()
  keyboard = true
  detach = attachTapToCaret(editor, { keyboardOpen: () => keyboard })
})

afterEach(() => {
  detach()
  editor.remove()
})

describe('attachTapToCaret', () => {
  it('moves the caret to a tap in another word and keeps the tap from Chromium', () => {
    caretAt(24)
    expect(tap(14)).toBe(true)
    const sel = getSelection()!
    expect(sel.anchorNode).toBe(text)
    expect(sel.anchorOffset).toBe(14)
    expect(sel.isCollapsed).toBe(true)
  })

  it('lets a tap in the word the caret is in through: tapping a misspelling twice opens the menu', () => {
    caretAt(24)
    expect(tap(14)).toBe(true)
    expect(tap(12)).toBe(false)
    // Its edges count as the word.
    caretAt(13)
    expect(tap(10)).toBe(false)
    expect(tap(19)).toBe(false)
  })

  it('leaves long presses, drags and taps with the keyboard down to the platform', () => {
    caretAt(24)
    expect(tap(14, { holdMs: 700 })).toBe(false)
    expect(tap(14, { moveBy: 30 })).toBe(false)
    keyboard = false
    expect(tap(14)).toBe(false)
    expect(getSelection()!.anchorOffset).toBe(24)
  })

  it('does nothing while the editor is not focused, or for a tap on something other than text', () => {
    caretAt(24)
    editor.blur()
    expect(tap(14)).toBe(false)
    editor.focus()
    caretAt(24)
    expect(tap(0, { node: editor })).toBe(false)
    const outside = document.createTextNode('elsewhere')
    document.body.append(outside)
    expect(tap(3, { node: outside })).toBe(false)
    outside.remove()
  })

  it('detaches', () => {
    detach()
    caretAt(24)
    expect(tap(14)).toBe(false)
    detach = () => {}
  })
})

describe('wordBounds', () => {
  it('spans the run of non-space characters around an offset', () => {
    expect(wordBounds('this is a misspeled word', 14)).toEqual({ start: 10, end: 19 })
    expect(wordBounds('this is a misspeled word', 10)).toEqual({ start: 10, end: 19 })
    expect(wordBounds('this is a misspeled word', 0)).toEqual({ start: 0, end: 4 })
    expect(wordBounds('a  b', 2)).toEqual({ start: 2, end: 2 })
  })
})

describe('keyboardLikelyOpen', () => {
  const setHeights = (avail: number, viewport: number) => {
    Object.defineProperty(window.screen, 'availHeight', { value: avail, configurable: true })
    Object.defineProperty(window, 'visualViewport', { value: { height: viewport }, configurable: true })
  }
  it('reads the keyboard from the gap between the screen and the visual viewport (Pixel 7)', () => {
    setHeights(915, 839)
    expect(keyboardLikelyOpen()).toBe(false)
    setHeights(915, 527)
    expect(keyboardLikelyOpen()).toBe(true)
  })
})

describe('isAndroidUserAgent', () => {
  it('knows Android Chrome and the WebView, and nothing else', () => {
    expect(isAndroidUserAgent('Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36')).toBe(true)
    expect(isAndroidUserAgent('Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 Version/4.0 Chrome/120 Mobile Safari/537.36')).toBe(true)
    expect(isAndroidUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148')).toBe(false)
    expect(isAndroidUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36')).toBe(false)
  })
})
