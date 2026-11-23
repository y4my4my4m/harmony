import { afterEach, describe, expect, it } from 'vitest'
import { FRAMES_UNSAFE_MARK, frameRefusal } from '../frameSupport'

const DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36'
const original = navigator.userAgent

function as(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => ua })
}

afterEach(() => as(original))

describe('frameRefusal', () => {
  it('runs built-ins and packages on desktop', () => {
    as(DESKTOP)
    expect(frameRefusal({ source: 'builtin' })).toBeNull()
    expect(frameRefusal({ source: 'package' })).toBeNull()
  })

  it('runs built-ins on a phone and keeps packages to computers', () => {
    as(ANDROID)
    expect(frameRefusal({ source: 'builtin' })).toBeNull()
    expect(frameRefusal({ source: 'package' })).toBe('PACKAGE_DESKTOP_ONLY')
  })

  it('runs nothing in an Android app whose WebView hands its bridge to every frame', () => {
    as(`${ANDROID} ${FRAMES_UNSAFE_MARK}`)
    expect(frameRefusal({ source: 'builtin' })).toBe('WEBVIEW_OUTDATED')
    expect(frameRefusal({ source: 'package' })).toBe('WEBVIEW_OUTDATED')
  })
})
