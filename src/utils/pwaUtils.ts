/**
 * Shared PWA detection and install diagnostics.
 */

import { debug } from '@/utils/debug'

const STANDALONE_DISPLAY_MODES = [
  '(display-mode: standalone)',
  '(display-mode: fullscreen)',
  '(display-mode: minimal-ui)',
  '(display-mode: window-controls-overlay)',
] as const

/**
 * True when the app runs as an installed PWA (any platform).
 */
export function isPWA(): boolean {
  if (typeof window === 'undefined') return false

  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) {
    return true
  }

  return STANDALONE_DISPLAY_MODES.some((query) => window.matchMedia(query).matches)
}

/**
 * Coarse mobile UA check (install deferral, touch UX).
 */
export function isMobileUserAgent(): boolean {
  return /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
}

/**
 * Only mobile should call preventDefault() on beforeinstallprompt so desktop
 * Chrome can use the native omnibox install UI.
 */
export function shouldDeferInstallPrompt(): boolean {
  return isMobileUserAgent()
}

export interface PWAInstallDiagnostics {
  manifestLinked: boolean
  manifestOk: boolean
  manifestErrors: string[]
  serviceWorkerSupported: boolean
  serviceWorkerActive: boolean
  serviceWorkerScope: string | null
  isSecureContext: boolean
  isStandalone: boolean
  canInstallDeferred: boolean
}

/**
 * Log installability hints (DevTools / chrome://app-installs complement).
 */
export async function logInstallDiagnostics(
  options?: { canInstallDeferred?: boolean }
): Promise<PWAInstallDiagnostics> {
  const diagnostics: PWAInstallDiagnostics = {
    manifestLinked: false,
    manifestOk: false,
    manifestErrors: [],
    serviceWorkerSupported: 'serviceWorker' in navigator,
    serviceWorkerActive: false,
    serviceWorkerScope: null,
    isSecureContext: typeof window !== 'undefined' && window.isSecureContext,
    isStandalone: isPWA(),
    canInstallDeferred: options?.canInstallDeferred ?? false,
  }

  const manifestLink = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
  diagnostics.manifestLinked = !!manifestLink?.href

  if (manifestLink?.href) {
    try {
      const response = await fetch(manifestLink.href)
      if (!response.ok) {
        diagnostics.manifestErrors.push(`Manifest fetch failed: ${response.status}`)
      } else {
        const manifest = await response.json()
        diagnostics.manifestOk = true
        if (!manifest.name) diagnostics.manifestErrors.push('Missing manifest.name')
        if (!manifest.icons?.length) diagnostics.manifestErrors.push('Missing manifest.icons')
        if (!manifest.start_url) diagnostics.manifestErrors.push('Missing manifest.start_url')
        if (!manifest.display) diagnostics.manifestErrors.push('Missing manifest.display')
      }
    } catch (err) {
      diagnostics.manifestErrors.push(
        err instanceof Error ? err.message : 'Manifest fetch error'
      )
    }
  } else {
    diagnostics.manifestErrors.push('No <link rel="manifest"> in document')
  }

  if (diagnostics.serviceWorkerSupported) {
    try {
      const registration = await navigator.serviceWorker.getRegistration()
      if (registration?.active) {
        diagnostics.serviceWorkerActive = true
        diagnostics.serviceWorkerScope = registration.scope
      } else if (registration?.installing || registration?.waiting) {
        diagnostics.manifestErrors.push('Service worker not yet active')
      } else {
        diagnostics.manifestErrors.push('No service worker registration')
      }
    } catch (err) {
      diagnostics.manifestErrors.push(
        err instanceof Error ? err.message : 'Service worker check failed'
      )
    }
  }

  debug.log('📋 PWA install diagnostics:', diagnostics)
  if (diagnostics.manifestErrors.length > 0) {
    debug.warn('📋 PWA install issues:', diagnostics.manifestErrors)
  }

  return diagnostics
}

/**
 * User-facing hint when programmatic install is unavailable.
 */
export function getManualInstallInstructions(): string {
  const ua = navigator.userAgent.toLowerCase()
  if (/iphone|ipad|ipod/.test(ua)) {
    return 'Tap Share, then "Add to Home Screen".'
  }
  if (/android/.test(ua)) {
    return 'Use Chrome menu (⋮) → Install app, or Add to Home screen.'
  }
  return 'Use the install icon in the address bar, or Chrome menu → "Install Harmony…".'
}

/**
 * Chromium-based desktop browser (Chrome, Edge, Opera, Brave, Vivaldi…).
 *
 * Used to gate the "Run on OS Login" suggestion - that feature is currently
 * only exposed by Chromium browsers via `about://apps` (Chrome 91+ / Edge 91+).
 *
 * See: https://developer.chrome.com/blog/run-on-login
 */
export function isChromiumDesktop(): boolean {
  if (typeof navigator === 'undefined') return false
  if (isMobileUserAgent()) return false
  const ua = navigator.userAgent
  // Modern Chromium browsers all include "Chrome/" in their UA token.
  // Exclude legacy non-Chromium Edge ("Edge/") and Firefox.
  if (!/Chrome\//.test(ua)) return false
  if (/Edge\//.test(ua)) return false
  if (/Firefox\//.test(ua)) return false
  return true
}

/**
 * URL to open in a browser tab so the user can flip
 * "Start app when you sign in" for the installed PWA.
 *
 * Returns Edge's URL when running in Edge so the address bar accepts it,
 * Chrome's URL otherwise. The shared `about://apps` alias works in both, but
 * showing the canonical URL is clearer for users we ask to copy & paste.
 */
export function getRunOnLoginUrl(): string {
  if (typeof navigator === 'undefined') return 'about://apps'
  return /Edg\//.test(navigator.userAgent) ? 'edge://apps' : 'chrome://apps'
}

/**
 * Human-friendly browser label for instructions ("Chrome" / "Edge" / "your browser").
 */
export function getChromiumBrowserLabel(): string {
  if (typeof navigator === 'undefined') return 'your browser'
  const ua = navigator.userAgent
  if (/Edg\//.test(ua)) return 'Edge'
  if (/OPR\//.test(ua)) return 'Opera'
  if (/Brave\//.test(ua)) return 'Brave'
  if (/Vivaldi\//.test(ua)) return 'Vivaldi'
  if (/Chrome\//.test(ua)) return 'Chrome'
  return 'your browser'
}
