// App zoom (Appearance → Zoom level).
//
// Desktop zooms its webview the way browser zoom does: the layout viewport
// shrinks, so media queries, viewport units, innerWidth and client rects all
// stay in one coordinate space. Android's WebView has no page zoom in wry, and
// a web page cannot set browser zoom, so those builds put CSS `zoom` on <html>.
//
// Under CSS `zoom`, Chromium (128+) multiplies viewport units by the zoom
// factor, so a 100vh box is 1.5 viewports tall at 150%; WebKit leaves them at
// the viewport size. --viewport-zoom holds the measured multiplier and the
// --app-vh/--app-dvh/--app-vw/... variables in design-system.css divide it out.
//
// Under CSS zoom, in both engines: getBoundingClientRect, MouseEvent
// clientX/clientY, innerWidth/innerHeight and elementFromPoint are in viewport
// pixels; offset*, client* and scroll* sizes and every length written to a
// style are in CSS pixels, which the zoom multiplies on screen. CSS = viewport
// / cssZoom(). The style* helpers below return viewport geometry in CSS pixels
// for positioning code; elementFromPoint keeps viewport pixels.

import { readonly, ref } from 'vue'
import { isTauriDesktop } from '@/utils/platform'
import { debug } from '@/utils/debug'

let appliedPercent = 100
let appliedMode: 'none' | 'native' | 'css' = 'none'
let cssFactor = 1
const cssFactorRef = ref(1)

/** cssZoom() as a ref, for computeds that size things from the viewport. */
export const cssZoomFactor = readonly(cssFactorRef)

function setCssFactor(factor: number): void {
  cssFactor = factor
  cssFactorRef.value = factor
}

/** Native webview zoom (desktop): screen logical px per client px. 1 unless native zoom is on. */
export function nativeZoomFactor(): number {
  return appliedMode === 'native' ? appliedPercent / 100 : 1
}

/** Divisor from viewport pixels (client rects, innerWidth) to style pixels. 1 unless CSS zoom is on. */
export function cssZoom(): number {
  return cssFactor
}

/** Viewport pixels to the CSS pixels a positioned element's style takes. */
export function toStylePx(viewportPx: number): number {
  return viewportPx / cssFactor
}

export interface StyleRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
  x: number
  y: number
}

/** getBoundingClientRect in CSS pixels. */
export function styleRect(el: Element): StyleRect {
  const r = el.getBoundingClientRect()
  const z = cssFactor
  return {
    left: r.left / z,
    top: r.top / z,
    right: r.right / z,
    bottom: r.bottom / z,
    width: r.width / z,
    height: r.height / z,
    x: r.x / z,
    y: r.y / z,
  }
}

/** innerWidth/innerHeight in CSS pixels, of the window showing `within`, else of the main window. */
export function styleViewport(within?: Node | null): { width: number; height: number } {
  const view = within?.ownerDocument?.defaultView ?? window
  return { width: view.innerWidth / cssFactor, height: view.innerHeight / cssFactor }
}

/** A pointer event's clientX/clientY in CSS pixels. */
export function stylePoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
  return { x: e.clientX / cssFactor, y: e.clientY / cssFactor }
}

/**
 * Factor by which the engine inflates viewport units under the current CSS
 * zoom: `factor` (Chromium, Firefox) or 1 (WebKit). Measured on width, which
 * a mobile browser's collapsing URL bar does not change.
 */
function viewportUnitMultiplier(factor: number): number {
  if (factor === 1 || !document.body || window.innerWidth <= 0) return 1
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;top:0;left:0;height:0;width:100vw;visibility:hidden;pointer-events:none'
  document.body.appendChild(probe)
  const ratio = probe.getBoundingClientRect().width / window.innerWidth
  probe.remove()
  return Math.abs(ratio - factor) < Math.abs(ratio - 1) ? factor : 1
}

function applyCssZoom(percent: number): void {
  const root = document.documentElement
  setCssFactor(percent / 100)
  if (percent === 100) {
    root.style.removeProperty('zoom')
    root.style.removeProperty('--viewport-zoom')
    return
  }
  root.style.setProperty('zoom', `${percent}%`)
  root.style.setProperty('--viewport-zoom', String(viewportUnitMultiplier(cssFactor)))
}

function clearCssZoom(): void {
  setCssFactor(1)
  document.documentElement.style.removeProperty('zoom')
  document.documentElement.style.removeProperty('--viewport-zoom')
}

/** Applies a zoom level in percent. Repeated calls with the same level do nothing. */
export function applyAppZoom(percent: number): void {
  if (!Number.isFinite(percent) || percent <= 0) percent = 100
  if (percent === appliedPercent && appliedMode !== 'none') return
  appliedPercent = percent

  if (isTauriDesktop() && appliedMode !== 'css') {
    appliedMode = 'native'
    clearCssZoom()
    import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(percent / 100))
      .catch((error) => {
        // A build without core:webview:allow-set-webview-zoom refuses the call.
        debug.warn('Native zoom unavailable, using CSS zoom:', error)
        appliedMode = 'css'
        applyCssZoom(appliedPercent)
      })
    return
  }

  appliedMode = 'css'
  applyCssZoom(percent)
}

/** Test hook: forgets the applied level and mode. */
export function resetAppZoomForTests(): void {
  appliedPercent = 100
  appliedMode = 'none'
  setCssFactor(1)
}
