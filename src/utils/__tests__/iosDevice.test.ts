import { describe, it, expect, vi, afterEach } from 'vitest'
import { isIOSDevice, isMobileUserAgent } from '../pwaUtils'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
// iPadOS Safari and WKWebView by default; a Mac sends the same string.
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'

function device(userAgent: string, maxTouchPoints: number) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
  vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(maxTouchPoints)
}

afterEach(() => vi.restoreAllMocks())

describe('isIOSDevice', () => {
  it('is true on an iPhone', () => {
    device(IPHONE, 5)
    expect(isIOSDevice()).toBe(true)
  })

  it('is true on an iPad sending the Mac user agent', () => {
    device(MAC, 5)
    expect(isIOSDevice()).toBe(true)
    expect(isMobileUserAgent()).toBe(true)
  })

  it('is false on a Mac, which has no touch points', () => {
    device(MAC, 0)
    expect(isIOSDevice()).toBe(false)
    expect(isMobileUserAgent()).toBe(false)
  })

  it('is false on Android, which is still a mobile user agent', () => {
    device(ANDROID, 5)
    expect(isIOSDevice()).toBe(false)
    expect(isMobileUserAgent()).toBe(true)
  })
})
