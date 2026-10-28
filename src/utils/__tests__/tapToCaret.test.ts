import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachTapToCaret, isAndroidUserAgent } from '../tapToCaret'

// A tap on the editor's text on Android focuses the editor, raises the keyboard and moves the
// caret without Chromium's tap handling (and its spelling menu), a second single tap in the same
// word included; the second tap of a double tap, a long press or a drag runs natively. With the
// keyboard down, Chromium's handling of a tap on an underlined word opens the menu instead of the
// keyboard (WebView 155 and Chrome 155, API 35, Gboard), focused editor or not.

let editor: HTMLDivElement
let text: Text
let detach: () => void

function touchEvent(type: 'touchstart' | 'touchend', x: number, y: number, timeStamp: number) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const touch = { clientX: x, clientY: y }
  Object.defineProperty(event, 'touches', { value: type === 'touchstart' ? [touch] : [] })
  Object.defineProperty(event, 'changedTouches', { value: [touch] })
  Object.defineProperty(event, 'timeStamp', { value: timeStamp })
  return event
}

let clock = 0

/**
 * A tap at character `offset`: caretRangeFromPoint answers that offset. Taps are a second apart
 * unless `after` (ms since the previous tap ended) says otherwise; `x` is where it lands.
 */
function tap(offset: number, opts: { moveBy?: number; holdMs?: number; node?: Node; after?: number; x?: number } = {}) {
  const node = opts.node ?? text
  document.caretRangeFromPoint = vi.fn(() => {
    const range = document.createRange()
    range.setStart(node, offset)
    return range
  })
  const x = opts.x ?? 100
  const start = clock + (opts.after ?? 1000)
  const end = start + (opts.holdMs ?? 80)
  clock = end
  editor.dispatchEvent(touchEvent('touchstart', x, 100, start))
  const touchend = touchEvent('touchend', x + (opts.moveBy ?? 0), 100, end)
  editor.dispatchEvent(touchend)
  return touchend.defaultPrevented
}

function caretAt(offset: number) {
  getSelection()!.collapse(text, offset)
}

/** The visual viewport as measured on a Pixel 7 (CSS px): the WebView resizes with the keyboard. */
function viewport(height: number) {
  Object.defineProperty(window.screen, 'availHeight', { value: 915, configurable: true })
  Object.defineProperty(window, 'visualViewport', { value: { height, scale: 1 }, configurable: true })
}

const KEYBOARD_DOWN = 838.5
const KEYBOARD_UP = 526.1

beforeEach(() => {
  editor = document.createElement('div')
  editor.contentEditable = 'true'
  text = document.createTextNode('this is a misspeled word')
  editor.append(text)
  document.body.append(editor)
  editor.focus()
  viewport(KEYBOARD_UP)
  detach = attachTapToCaret(editor)
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

  it('keeps a second single tap in the same word from Chromium too: it only moves the caret', () => {
    caretAt(24)
    expect(tap(14)).toBe(true)
    expect(tap(12)).toBe(true)
    expect(getSelection()!.anchorOffset).toBe(12)
  })

  it('lets the second tap of a double tap through: double-tapping a misspelling opens the menu', () => {
    caretAt(24)
    expect(tap(14)).toBe(true)
    expect(tap(14, { after: 200, x: 110 })).toBe(false)
    // A third tap starts over.
    expect(tap(14, { after: 200 })).toBe(true)
  })

  it('is no double tap when the second tap is late or elsewhere', () => {
    caretAt(24)
    expect(tap(14)).toBe(true)
    expect(tap(14, { after: 600 })).toBe(true)
    expect(tap(3, { after: 150, x: 300 })).toBe(true)
  })

  it('keeps a tap from Chromium with the keyboard down: Chromium would open the menu instead of the keyboard', () => {
    // The reaction picker's search raised the keyboard; picking an emoji takes it down.
    caretAt(24)
    viewport(KEYBOARD_DOWN)
    expect(tap(14)).toBe(true)
    expect(getSelection()!.anchorOffset).toBe(14)
    // Chrome: the keyboard shrinks only the visual viewport.
    viewport(806.5)
    expect(tap(3)).toBe(true)
    expect(getSelection()!.anchorOffset).toBe(3)
  })

  it('focuses an unfocused editor at the tapped point, within the tap', () => {
    // Focus left on the reaction button when the picker closed.
    const button = document.createElement('button')
    document.body.append(button)
    button.focus()
    viewport(KEYBOARD_DOWN)
    expect(tap(14)).toBe(true)
    expect(document.activeElement).toBe(editor)
    expect(getSelection()!.anchorNode).toBe(text)
    expect(getSelection()!.anchorOffset).toBe(14)
    button.remove()
  })

  it('focuses a focused editor again in every handled tap: the tap\'s activation raises the keyboard', () => {
    const focus = vi.spyOn(editor, 'focus')
    caretAt(24)
    expect(tap(14)).toBe(true)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    // The focus precedes the caret: focusing an editor can move its selection.
    expect(getSelection()!.anchorOffset).toBe(14)
  })

  it('leaves long presses and drags to the platform', () => {
    caretAt(24)
    expect(tap(14, { holdMs: 700 })).toBe(false)
    expect(tap(14, { moveBy: 30 })).toBe(false)
    expect(getSelection()!.anchorOffset).toBe(24)
  })

  it('leaves taps on anything but the editor\'s own text to the platform, a mention pill\'s included', () => {
    caretAt(24)
    expect(tap(0, { node: editor })).toBe(false)
    const outside = document.createTextNode('elsewhere')
    document.body.append(outside)
    expect(tap(3, { node: outside })).toBe(false)
    outside.remove()
    const pill = document.createElement('span')
    pill.contentEditable = 'false'
    const name = document.createTextNode('@alice')
    pill.append(name)
    editor.append(pill)
    expect(tap(2, { node: name })).toBe(false)
    expect(getSelection()!.anchorOffset).toBe(24)
  })

  it('detaches', () => {
    detach()
    caretAt(24)
    expect(tap(14)).toBe(false)
    detach = () => {}
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
