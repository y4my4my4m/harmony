import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const env = vi.hoisted(() => ({ ios: true, zoom: 1 }))
vi.mock('@/utils/platform', () => ({ isIOSDevice: () => env.ios }))
vi.mock('@/utils/appZoom', () => ({ cssZoom: () => env.zoom }))

import { installIOSKeyboardInset, keyboardOverlap } from '../iosKeyboard'

/** visualViewport and the window fields the installer reads, as iOS WebKit reports them. */
function fakeWindow(layoutHeight: number, contentHeight = layoutHeight) {
  const vv = Object.assign(new EventTarget(), { height: layoutHeight, scale: 1 })
  const scrollingElement = { scrollHeight: contentHeight }
  const win = {
    visualViewport: vv,
    innerHeight: layoutHeight,
    scrollY: 0,
    scrollTo: vi.fn((_x: number, y: number) => { win.scrollY = y }),
    document: { documentElement: document.documentElement, scrollingElement },
  }
  const keyboard = (height: number, scrollY = 0) => {
    vv.height = layoutHeight - height
    win.scrollY = scrollY
    vv.dispatchEvent(new Event('resize'))
  }
  return { win: win as unknown as Window, vv, keyboard, scrollTo: win.scrollTo }
}

const prop = (name: string) => document.documentElement.style.getPropertyValue(name)

let uninstall: () => void = () => {}

beforeEach(() => {
  env.ios = true
  env.zoom = 1
  document.documentElement.removeAttribute('style')
})

afterEach(() => uninstall())

describe('keyboardOverlap', () => {
  it('is the layout height the visual viewport lost, in whole px', () => {
    expect(keyboardOverlap(852, { height: 515.6, scale: 1 })).toBe(336)
    expect(keyboardOverlap(852, { height: 852, scale: 1 })).toBe(0)
  })

  it('is 0 while pinch-zoomed', () => {
    expect(keyboardOverlap(852, { height: 426, scale: 2 })).toBe(0)
  })
})

describe('installIOSKeyboardInset', () => {
  it('writes the overlap and drops the home indicator inset while the keyboard is up', () => {
    const f = fakeWindow(852)
    uninstall = installIOSKeyboardInset(f.win)
    expect(prop('--keyboard-inset')).toBe('')

    f.keyboard(336)
    expect(prop('--keyboard-inset')).toBe('336px')
    expect(prop('--shell-safe-bottom')).toBe('0px')

    f.keyboard(0)
    expect(prop('--keyboard-inset')).toBe('')
    expect(prop('--shell-safe-bottom')).toBe('')
  })

  it('writes CSS px under CSS zoom', () => {
    env.zoom = 1.5
    const f = fakeWindow(852)
    uninstall = installIOSKeyboardInset(f.win)
    f.keyboard(336)
    expect(prop('--keyboard-inset')).toBe('224px')
  })

  it('undoes the document scroll of a shell that fits the viewport', () => {
    const f = fakeWindow(852)
    uninstall = installIOSKeyboardInset(f.win)
    f.keyboard(336, 300)
    expect(f.scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it('leaves a page taller than the viewport scrolled where iOS put it', () => {
    const f = fakeWindow(852, 2400)
    uninstall = installIOSKeyboardInset(f.win)
    f.keyboard(336, 900)
    expect(f.scrollTo).not.toHaveBeenCalled()
    expect(prop('--keyboard-inset')).toBe('336px')
  })

  it('does nothing outside iOS', () => {
    env.ios = false
    const f = fakeWindow(852)
    uninstall = installIOSKeyboardInset(f.win)
    f.keyboard(336)
    expect(prop('--keyboard-inset')).toBe('')
  })

  it('stops listening and clears the variables when uninstalled', () => {
    const f = fakeWindow(852)
    uninstall = installIOSKeyboardInset(f.win)
    f.keyboard(336)
    uninstall()
    expect(prop('--keyboard-inset')).toBe('')
    f.keyboard(200)
    expect(prop('--keyboard-inset')).toBe('')
  })
})
