/**
 * Device description from a User-Agent string, for the sessions list and security notices.
 * Mirrors describeUserAgent in federation-backend/src/services/pushPolicy.ts.
 *
 * Native clients send their webview's agent: Android WebView carries "; wv)", the Linux
 * desktop app runs WebKitGTK (a Safari-shaped agent on Linux), Windows runs WebView2 (Edge).
 */

export type DeviceKind = 'phone' | 'tablet' | 'desktop' | 'unknown'

export interface DeviceDescription {
  /** "Firefox on Linux", "Harmony app on Android"; null when nothing is recognised. */
  label: string | null
  kind: DeviceKind
}

export function describeUserAgent(userAgent: string | null | undefined): DeviceDescription {
  if (!userAgent) return { label: null, kind: 'unknown' }
  const ua = userAgent

  const os = /Android/.test(ua) ? 'Android'
    : /iPad/.test(ua) ? 'iPadOS'
    : /iPhone|iPod/.test(ua) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux|X11/.test(ua) ? 'Linux'
    : null

  const linuxWebKit = os === 'Linux' && /AppleWebKit/.test(ua) && !/Chrome\/|Chromium\//.test(ua)
  const browser = /; wv\)/.test(ua) || linuxWebKit ? 'Harmony app'
    : /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\/|Chromium\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : null

  const kind: DeviceKind = /iPad|Tablet/.test(ua) ? 'tablet'
    : /Mobi|Android|iPhone|iPod/.test(ua) ? 'phone'
    : os ? 'desktop'
    : 'unknown'

  const label = browser && os ? `${browser} on ${os}` : browser ?? os
  return { label, kind }
}
