/**
 * utils/mediaFullscreen: the Fullscreen API with its webkit fallbacks, iOS's system player
 * for video, and the Linux desktop app's window following element fullscreen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appWindow = {
  isFullscreen: vi.fn(async () => false),
  setFullscreen: vi.fn(async (_fullscreen: boolean) => {}),
}
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => appWindow }))

import {
  canFullscreen,
  enterFullscreen,
  exitFullscreen,
  installWindowFullscreenSync,
  isFullscreen,
  toggleFullscreen,
  windowFollowsElementFullscreen,
  type WebkitVideo,
} from '@/utils/mediaFullscreen'

const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36'
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko)'
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36'

let shown: Element | null = null
let uninstall: (() => void) | null = null

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })
}

/** Document with the standard API: requestFullscreen shows the element and fires the change. */
function withFullscreenApi(enabled = true) {
  Object.defineProperty(document, 'fullscreenEnabled', { value: enabled, configurable: true })
  Object.defineProperty(document, 'fullscreenElement', { get: () => shown, configurable: true })
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    value: vi.fn(async () => {
      shown = null
      document.dispatchEvent(new Event('fullscreenchange'))
    }),
  })
}

function fullscreenTarget(): HTMLElement {
  const el = document.createElement('div')
  el.requestFullscreen = vi.fn(async () => {
    shown = el
    document.dispatchEvent(new Event('fullscreenchange'))
  }) as HTMLElement['requestFullscreen']
  document.body.appendChild(el)
  return el
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  shown = null
  setUserAgent(LINUX_UA)
  appWindow.isFullscreen.mockReset().mockResolvedValue(false)
  appWindow.setFullscreen.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  uninstall?.()
  uninstall = null
  for (const key of ['fullscreenEnabled', 'fullscreenElement', 'exitFullscreen', 'webkitFullscreenEnabled']) {
    delete (document as unknown as Record<string, unknown>)[key]
  }
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__
  document.body.innerHTML = ''
})

describe('availability', () => {
  it('has no control without the API or a system player', () => {
    withFullscreenApi(false)
    expect(canFullscreen()).toBe(false)
    expect(canFullscreen(document.createElement('video'))).toBe(false)
  })

  it('has the control where the document allows element fullscreen, standard or prefixed', () => {
    withFullscreenApi(true)
    expect(canFullscreen()).toBe(true)
    delete (document as unknown as Record<string, unknown>).fullscreenEnabled
    Object.defineProperty(document, 'webkitFullscreenEnabled', { value: true, configurable: true })
    expect(canFullscreen()).toBe(true)
  })

  it("offers a video WebKit's system player when elements cannot go fullscreen", () => {
    withFullscreenApi(false)
    const video = document.createElement('video') as WebkitVideo
    video.webkitEnterFullscreen = vi.fn()
    expect(canFullscreen()).toBe(false)
    expect(canFullscreen(video)).toBe(true)
  })
})

describe('enter, leave and toggle', () => {
  it('shows the container fullscreen without navigation UI and leaves it again', async () => {
    withFullscreenApi()
    const target = fullscreenTarget()
    expect(await enterFullscreen(target)).toBe(true)
    expect(target.requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' })
    expect(isFullscreen(target)).toBe(true)
    await exitFullscreen()
    expect(document.exitFullscreen).toHaveBeenCalled()
    expect(isFullscreen(target)).toBe(false)
  })

  it('falls back to webkitRequestFullscreen', async () => {
    withFullscreenApi()
    const target = document.createElement('div') as HTMLElement & { webkitRequestFullscreen: () => void }
    Object.defineProperty(target, 'requestFullscreen', { value: undefined })
    target.webkitRequestFullscreen = vi.fn()
    expect(await enterFullscreen(target)).toBe(true)
    expect(target.webkitRequestFullscreen).toHaveBeenCalled()
  })

  it('plays video in the system player on iOS, not in a fullscreen element', async () => {
    setUserAgent(IPHONE_UA)
    withFullscreenApi(true)
    const target = fullscreenTarget()
    const video = document.createElement('video') as WebkitVideo
    video.webkitEnterFullscreen = vi.fn(() => {
      video.webkitDisplayingFullscreen = true
    })
    expect(await enterFullscreen(target, video)).toBe(true)
    expect(video.webkitEnterFullscreen).toHaveBeenCalled()
    expect(target.requestFullscreen).not.toHaveBeenCalled()
    expect(isFullscreen(target, video)).toBe(true)

    video.webkitExitFullscreen = vi.fn(() => {
      video.webkitDisplayingFullscreen = false
    })
    expect(await toggleFullscreen(target, video)).toBe(false)
    expect(video.webkitExitFullscreen).toHaveBeenCalled()
  })

  it('reports a refused request', async () => {
    withFullscreenApi()
    const target = document.createElement('div')
    target.requestFullscreen = vi.fn(async () => {
      throw new TypeError('Permissions check failed')
    }) as HTMLElement['requestFullscreen']
    expect(await enterFullscreen(target)).toBe(false)
  })

  it('toggles: enters, then leaves', async () => {
    withFullscreenApi()
    const target = fullscreenTarget()
    expect(await toggleFullscreen(target)).toBe(true)
    expect(shown).toBe(target)
    expect(await toggleFullscreen(target)).toBe(false)
    expect(shown).toBeNull()
  })
})

describe('the Linux desktop window follows element fullscreen', () => {
  function asDesktopApp(ua = LINUX_UA) {
    setUserAgent(ua)
    ;(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  }

  it('runs on the Linux desktop app only', () => {
    expect(windowFollowsElementFullscreen()).toBe(false)
    asDesktopApp(MAC_UA)
    expect(windowFollowsElementFullscreen()).toBe(false)
    asDesktopApp(ANDROID_UA)
    expect(windowFollowsElementFullscreen()).toBe(false)
    asDesktopApp(LINUX_UA)
    expect(windowFollowsElementFullscreen()).toBe(true)
  })

  it('puts the window into fullscreen with the element and restores it after', async () => {
    asDesktopApp()
    withFullscreenApi()
    uninstall = installWindowFullscreenSync()
    const target = fullscreenTarget()
    await enterFullscreen(target)
    await settle()
    expect(appWindow.setFullscreen).toHaveBeenCalledWith(true)
    await exitFullscreen()
    await settle()
    expect(appWindow.setFullscreen).toHaveBeenLastCalledWith(false)
    expect(appWindow.setFullscreen).toHaveBeenCalledTimes(2)
  })

  it('leaves a window that was already fullscreen as it was', async () => {
    asDesktopApp()
    withFullscreenApi()
    appWindow.isFullscreen.mockResolvedValue(true)
    uninstall = installWindowFullscreenSync()
    const target = fullscreenTarget()
    await enterFullscreen(target)
    await settle()
    await exitFullscreen()
    await settle()
    expect(appWindow.setFullscreen).not.toHaveBeenCalled()
  })

  it.each(['F11', 'Escape'])('%s leaves element fullscreen, and the window follows', async (key) => {
    asDesktopApp()
    withFullscreenApi()
    uninstall = installWindowFullscreenSync()
    const target = fullscreenTarget()
    await enterFullscreen(target)
    await settle()
    const later = vi.fn()
    window.addEventListener('keydown', later)
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    window.dispatchEvent(event)
    window.removeEventListener('keydown', later)
    await settle()
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(later).not.toHaveBeenCalled()
    expect(shown).toBeNull()
    expect(appWindow.setFullscreen).toHaveBeenLastCalledWith(false)
  })

  it('lets F11 and Escape through when nothing is fullscreen', () => {
    asDesktopApp()
    withFullscreenApi()
    uninstall = installWindowFullscreenSync()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('installs nothing in a browser', async () => {
    withFullscreenApi()
    uninstall = installWindowFullscreenSync()
    await enterFullscreen(fullscreenTarget())
    await settle()
    expect(appWindow.setFullscreen).not.toHaveBeenCalled()
  })
})
