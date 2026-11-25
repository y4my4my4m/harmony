import { isMobileUserAgent } from '@/utils/pwaUtils'
import type { ActivityApp } from './catalog'

/** Added to the Android app's user agent when its WebView lacks WebMessageListener (MainFrameIpc.kt). */
export const FRAMES_UNSAFE_MARK = 'HarmonyFramesUnsafe'

export type FrameRefusal = 'WEBVIEW_OUTDATED' | 'PACKAGE_DESKTOP_ONLY'

/**
 * Why an activity's frame may not run on this device, or null.
 *
 * - WEBVIEW_OUTDATED: the Android app's WebView hands its native bridge to every frame; no
 *   activity runs there.
 * - PACKAGE_DESKTOP_ONLY: phones and tablets run a frame in the page's own web process (Android
 *   WebView, WKWebView, mobile Safari), where an activity that never yields freezes the app with
 *   it. Built-ins ship with this build; installed packages run on desktop and web, where the
 *   browser runs the sandboxed frame in a process of its own.
 */
export function frameRefusal(app: Pick<ActivityApp, 'source'>): FrameRefusal | null {
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes(FRAMES_UNSAFE_MARK)) return 'WEBVIEW_OUTDATED'
  if (app.source === 'package' && isMobileUserAgent()) return 'PACKAGE_DESKTOP_ONLY'
  return null
}
