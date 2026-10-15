import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'

const platform = vi.hoisted(() => ({ desktop: false }))
const webview = vi.hoisted(() => ({ setZoom: vi.fn() }))

vi.mock('@/utils/platform', () => ({ isTauriDesktop: () => platform.desktop }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ setZoom: webview.setZoom }) }))

import {
  applyAppZoom,
  cssZoom,
  resetAppZoomForTests,
  styleRect,
  stylePoint,
  styleViewport,
  toStylePx,
} from '../appZoom'
import { useViewport } from '@/composables/useViewport'

const root = () => document.documentElement

/** A 100vw probe reports `multiplier` viewports wide, as Chromium does under CSS zoom. */
function viewportUnitsInflatedBy(multiplier: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.style.width === '100vw' ? window.innerWidth * multiplier : 0
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 0, width, height: 0, toJSON() {} } as DOMRect
  })
}

beforeEach(() => {
  resetAppZoomForTests()
  platform.desktop = false
  webview.setZoom.mockReset()
  root().removeAttribute('style')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('applyAppZoom on web and Android', () => {
  it('zooms the root with CSS and records the viewport-unit multiplier Chromium applies', () => {
    viewportUnitsInflatedBy(1.5)
    applyAppZoom(150)
    expect(root().style.getPropertyValue('zoom')).toBe('150%')
    expect(root().style.getPropertyValue('--viewport-zoom')).toBe('1.5')
    expect(cssZoom()).toBe(1.5)
  })

  it('records 1 where viewport units keep the viewport size, as in WebKit', () => {
    viewportUnitsInflatedBy(1)
    applyAppZoom(150)
    expect(root().style.getPropertyValue('--viewport-zoom')).toBe('1')
  })

  it('clears the zoom at 100%', () => {
    viewportUnitsInflatedBy(1.5)
    applyAppZoom(150)
    applyAppZoom(100)
    expect(root().style.getPropertyValue('zoom')).toBe('')
    expect(root().style.getPropertyValue('--viewport-zoom')).toBe('')
    expect(cssZoom()).toBe(1)
  })

  it('converts viewport geometry into CSS pixels', () => {
    viewportUnitsInflatedBy(2)
    applyAppZoom(200)
    expect(toStylePx(300)).toBe(150)
    expect(stylePoint({ clientX: 400, clientY: 100 })).toEqual({ x: 200, y: 50 })
    expect(styleViewport()).toEqual({ width: window.innerWidth / 2, height: window.innerHeight / 2 })

    const el = document.createElement('div')
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(
      { x: 100, y: 60, left: 100, top: 60, right: 300, bottom: 160, width: 200, height: 100, toJSON() {} } as DOMRect,
    )
    expect(styleRect(el)).toEqual({ x: 50, y: 30, left: 50, top: 30, right: 150, bottom: 80, width: 100, height: 50 })
  })
})

describe('useViewport under CSS zoom', () => {
  it('reports width and height in CSS pixels and keeps the mobile breakpoint on viewport pixels', async () => {
    viewportUnitsInflatedBy(2)
    const { viewportWidth, viewportHeight, isMobileViewport } = useViewport()
    applyAppZoom(200)
    await nextTick()
    expect(viewportWidth.value).toBe(window.innerWidth / 2)
    expect(viewportHeight.value).toBe(window.innerHeight / 2)
    expect(isMobileViewport.value).toBe(window.innerWidth <= 768)

    applyAppZoom(100)
    await nextTick()
    expect(viewportWidth.value).toBe(window.innerWidth)
  })
})

describe('applyAppZoom on desktop', () => {
  it('zooms the webview and leaves CSS zoom off', async () => {
    platform.desktop = true
    webview.setZoom.mockResolvedValue(undefined)
    applyAppZoom(125)
    await vi.waitFor(() => expect(webview.setZoom).toHaveBeenCalledWith(1.25))
    expect(root().style.getPropertyValue('zoom')).toBe('')
    expect(cssZoom()).toBe(1)
  })

  it('falls back to CSS zoom when the webview refuses', async () => {
    platform.desktop = true
    webview.setZoom.mockRejectedValue(new Error('not allowed'))
    viewportUnitsInflatedBy(1.25)
    applyAppZoom(125)
    await vi.waitFor(() => expect(root().style.getPropertyValue('zoom')).toBe('125%'))
    expect(cssZoom()).toBe(1.25)

    applyAppZoom(150)
    expect(webview.setZoom).toHaveBeenCalledTimes(1)
    expect(root().style.getPropertyValue('zoom')).toBe('150%')
  })

  it('does nothing for a repeated level', async () => {
    platform.desktop = true
    webview.setZoom.mockResolvedValue(undefined)
    applyAppZoom(110)
    applyAppZoom(110)
    await vi.waitFor(() => expect(webview.setZoom).toHaveBeenCalledTimes(1))
  })
})
