// Canonical platform detection - single import site for feature gating.
// Matrix: web | pwa (installed) | tauri-desktop | tauri-mobile.

import { isTauriRuntime } from '@/services/instanceConfig'
import { isPWA, isMobileUserAgent } from '@/utils/pwaUtils'

export type AppPlatform = 'web' | 'pwa' | 'tauri-desktop' | 'tauri-mobile'

export { isTauriRuntime as isTauri, isPWA, isMobileUserAgent }

export function isMobileDevice(): boolean {
  return isMobileUserAgent()
}

export function isTauriDesktop(): boolean {
  return isTauriRuntime() && !isMobileUserAgent()
}

export function isTauriMobile(): boolean {
  return isTauriRuntime() && isMobileUserAgent()
}

export function getAppPlatform(): AppPlatform {
  if (isTauriRuntime()) return isMobileUserAgent() ? 'tauri-mobile' : 'tauri-desktop'
  return isPWA() ? 'pwa' : 'web'
}

// Web Push never works inside the native webview; native uses OS
// notifications while running (FCM/APNs later for closed-app push).
export function supportsWebPush(): boolean {
  if (isTauriRuntime()) return false
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

// Desktop Chrome exposes navigator.vibrate as a no-op, so require mobile.
export function supportsHaptics(): boolean {
  if (typeof navigator === 'undefined') return false
  return 'vibrate' in navigator && isMobileUserAgent()
}

export function canInstallPWA(): boolean {
  return !isTauriRuntime() && !isPWA()
}
