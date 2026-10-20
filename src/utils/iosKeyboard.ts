// Software keyboard in iOS WebKit (Safari, Home Screen web app, the iOS app).
//
// iOS lays the keyboard over the layout viewport: innerHeight and viewport
// units keep their size, visualViewport shrinks, and the document scrolls to
// reveal the focused field. The Android app resizes its WebView instead
// (adjustResize). --keyboard-inset carries the overlap into the --app-vh family
// (design-system.css), --shell-safe-bottom drops the home indicator inset the
// keyboard covers, and the document scroll is undone while the shell fits.
//
// Under CSS zoom WebKit renders viewport units at the viewport size and scales
// px by the zoom, so the inset is written in CSS px (viewport / zoom).

import { cssZoom } from '@/utils/appZoom'
import { isIOSDevice } from '@/utils/platform'

type ViewportSize = Pick<VisualViewport, 'height' | 'scale'>

/** Keyboard overlap of the layout viewport in viewport px. 0 while pinch-zoomed: the visual viewport shrinks then too. */
export function keyboardOverlap(layoutHeight: number, vv: ViewportSize): number {
  if (vv.scale > 1.01) return 0
  return Math.max(0, Math.round(layoutHeight - vv.height))
}

let uninstall: (() => void) | null = null

export function installIOSKeyboardInset(win: Window = window): () => void {
  if (uninstall) return uninstall
  const vv = win.visualViewport
  if (!vv || !isIOSDevice()) return () => {}
  const root = win.document.documentElement
  let applied = 0

  const sync = () => {
    const overlap = keyboardOverlap(win.innerHeight, vv)
    if (overlap !== applied) {
      applied = overlap
      if (overlap > 0) {
        root.style.setProperty('--keyboard-inset', `${overlap / cssZoom()}px`)
        root.style.setProperty('--shell-safe-bottom', '0px')
      } else {
        root.style.removeProperty('--keyboard-inset')
        root.style.removeProperty('--shell-safe-bottom')
      }
    }
    // A page taller than the viewport scrolls on its own; only the fixed shell is pinned.
    const doc = win.document.scrollingElement
    if (overlap > 0 && doc && doc.scrollHeight <= win.innerHeight + 1 && win.scrollY !== 0) {
      win.scrollTo(0, 0)
    }
  }

  vv.addEventListener('resize', sync)
  vv.addEventListener('scroll', sync)
  sync()
  uninstall = () => {
    vv.removeEventListener('resize', sync)
    vv.removeEventListener('scroll', sync)
    root.style.removeProperty('--keyboard-inset')
    root.style.removeProperty('--shell-safe-bottom')
    uninstall = null
  }
  return uninstall
}
