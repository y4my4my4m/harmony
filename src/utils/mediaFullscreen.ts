// True fullscreen for media: the Fullscreen API on a container, the system player for
// video on iOS, and the window itself on the Linux desktop app.
//
//   Browsers      Element.requestFullscreen, else webkitRequestFullscreen (Safari < 16.4).
//   iOS           HTMLVideoElement.webkitEnterFullscreen: the system player. iPhone has no
//                 element fullscreen, so images and audio get no control there.
//   Android app   requestFullscreen reaches WebChromeClient.onShowCustomView
//                 (FullscreenChromeClient.kt), which shows the content over the window.
//   Linux app     CEF's element fullscreen fills the browser view only; the window follows
//                 through installWindowFullscreenSync.
//   Windows app   tauri-runtime-wry sets window fullscreen on WebView2's
//                 ContainsFullScreenElementChanged.
//   macOS app     WKWebView's element fullscreen opens its own fullscreen window.

import { isIOSDevice, isTauriDesktop } from '@/utils/platform'

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitFullscreenEnabled?: boolean
  webkitExitFullscreen?: () => Promise<void> | void
}

type FullscreenTarget = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
}

/** HTMLVideoElement with WebKit's system player. */
export type WebkitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void
  webkitExitFullscreen?: () => void
  webkitDisplayingFullscreen?: boolean
}

/** Document events for element fullscreen changes. */
export const FULLSCREEN_EVENTS = ['fullscreenchange', 'webkitfullscreenchange'] as const

/** Video events of WebKit's system player; they do not bubble. */
export const NATIVE_VIDEO_FULLSCREEN_EVENTS = ['webkitbeginfullscreen', 'webkitendfullscreen'] as const

function doc(): FullscreenDocument | null {
  return typeof document === 'undefined' ? null : (document as FullscreenDocument)
}

/** The element shown fullscreen, standard or prefixed. */
export function fullscreenElement(): Element | null {
  const d = doc()
  if (!d) return null
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null
}

function elementFullscreenEnabled(): boolean {
  const d = doc()
  return !!d && (d.fullscreenEnabled === true || d.webkitFullscreenEnabled === true)
}

function systemPlayer(video: HTMLVideoElement | null | undefined): video is WebkitVideo {
  return !!video && typeof (video as WebkitVideo).webkitEnterFullscreen === 'function'
}

/** True when `video` plays in WebKit's system player instead of in a fullscreen element. */
function prefersSystemPlayer(video: HTMLVideoElement | null | undefined): video is WebkitVideo {
  return systemPlayer(video) && (isIOSDevice() || !elementFullscreenEnabled())
}

/** True when fullscreen can be entered for a container, or for `video` when given. */
export function canFullscreen(video?: HTMLVideoElement | null): boolean {
  return elementFullscreenEnabled() || systemPlayer(video)
}

/** True while `target` is the fullscreen element, or `video` plays in the system player. */
export function isFullscreen(target: Element | null | undefined, video?: HTMLVideoElement | null): boolean {
  if ((video as WebkitVideo | null | undefined)?.webkitDisplayingFullscreen === true) return true
  return !!target && fullscreenElement() === target
}

/**
 * Enters fullscreen with `target`, or plays `video` in the system player where that is the
 * platform's only fullscreen (iOS). Runs its first step synchronously: call it from the user
 * gesture. Resolves false when the platform refused.
 */
export async function enterFullscreen(target: HTMLElement, video?: HTMLVideoElement | null): Promise<boolean> {
  if (prefersSystemPlayer(video)) {
    try {
      video.webkitEnterFullscreen!()
      return true
    } catch {
      return false
    }
  }
  const el = target as FullscreenTarget
  try {
    if (typeof el.requestFullscreen === 'function') {
      await el.requestFullscreen({ navigationUI: 'hide' })
      return true
    }
    if (typeof el.webkitRequestFullscreen === 'function') {
      await el.webkitRequestFullscreen()
      return true
    }
  } catch {
    return false
  }
  if (systemPlayer(video)) {
    try {
      video.webkitEnterFullscreen!()
      return true
    } catch {
      return false
    }
  }
  return false
}

/** Leaves element fullscreen, and the system player of `video` when it shows. */
export async function exitFullscreen(video?: HTMLVideoElement | null): Promise<void> {
  const v = video as WebkitVideo | null | undefined
  if (v?.webkitDisplayingFullscreen && typeof v.webkitExitFullscreen === 'function') {
    try {
      v.webkitExitFullscreen()
    } catch {
      /* already left */
    }
  }
  const d = doc()
  if (!d || !fullscreenElement()) return
  try {
    if (typeof d.exitFullscreen === 'function') await d.exitFullscreen()
    else await d.webkitExitFullscreen?.()
  } catch {
    /* already left */
  }
}

/** Enters fullscreen, or leaves it when `target` (or `video`) is fullscreen. */
export async function toggleFullscreen(target: HTMLElement, video?: HTMLVideoElement | null): Promise<boolean> {
  if (isFullscreen(target, video)) {
    await exitFullscreen(video)
    return false
  }
  return enterFullscreen(target, video)
}

/** Calls `listener` on every element fullscreen change; returns its removal. */
export function onFullscreenChange(listener: () => void): () => void {
  const d = doc()
  if (!d) return () => {}
  for (const type of FULLSCREEN_EVENTS) d.addEventListener(type, listener)
  return () => {
    for (const type of FULLSCREEN_EVENTS) d.removeEventListener(type, listener)
  }
}

// --- Linux desktop app: the window follows element fullscreen --------------------------

interface AppWindow {
  isFullscreen(): Promise<boolean>
  setFullscreen(fullscreen: boolean): Promise<void>
}

async function appWindow(): Promise<AppWindow | null> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    return getCurrentWindow()
  } catch {
    return null
  }
}

/** True on the Linux desktop app, whose webview runtime leaves the window alone. */
export function windowFollowsElementFullscreen(): boolean {
  if (typeof navigator === 'undefined' || !isTauriDesktop()) return false
  const ua = navigator.userAgent
  return /Linux/i.test(ua) && !/Android/i.test(ua)
}

/**
 * Linux desktop app: puts the window into fullscreen while any element is fullscreen (a
 * media viewer, a player, an embed's iframe) and restores the window's own state after.
 * F11 and Escape leave element fullscreen while it lasts; CEF hands both to the page.
 * Returns the uninstall; elsewhere it installs nothing.
 */
export function installWindowFullscreenSync(): () => void {
  const d = doc()
  if (!d || typeof window === 'undefined' || !windowFollowsElementFullscreen()) return () => {}

  // Window state before the element went fullscreen; null outside a session.
  let restoreTo: boolean | null = null
  let chain: Promise<void> = Promise.resolve()
  const serial = (step: () => Promise<void>) => {
    chain = chain.then(step, step)
  }

  const onChange = () =>
    serial(async () => {
      const shown = fullscreenElement()
      if (shown && restoreTo === null) {
        const win = await appWindow()
        if (!win) return
        restoreTo = await win.isFullscreen().catch(() => false)
        if (!restoreTo) await win.setFullscreen(true).catch(() => {})
      } else if (!shown && restoreTo !== null) {
        const was = restoreTo
        restoreTo = null
        if (was) return
        const win = await appWindow()
        await win?.setFullscreen(false).catch(() => {})
      }
    })

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'F11' && event.key !== 'Escape') return
    if (!fullscreenElement()) return
    event.preventDefault()
    event.stopImmediatePropagation()
    void exitFullscreen()
  }

  const removeChange = onFullscreenChange(onChange)
  window.addEventListener('keydown', onKeydown, true)
  return () => {
    removeChange()
    window.removeEventListener('keydown', onKeydown, true)
  }
}
