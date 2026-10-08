// Build and runtime identity for support reports.
// __APP_* constants come from the Vite `define` in vite.config.ts; the typeof
// guards cover runners that do not define them (vitest).

import { getAppPlatform } from '@/utils/platform'
import { apiUrl, getInstanceDomain, isTauriRuntime } from '@/services/instanceConfig'

export interface BuildInfo {
  version: string
  commit: string
  buildDate: string
}

export function getBuildInfo(): BuildInfo {
  return {
    version: typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__ ? __APP_VERSION__ : 'unknown',
    commit: typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : '',
    buildDate: typeof __APP_BUILD_DATE__ !== 'undefined' ? __APP_BUILD_DATE__ : '',
  }
}

export type DesktopOs = 'windows' | 'macos' | 'linux'

export function detectDesktopOs(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): DesktopOs | null {
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return null
}

// web | pwa | android | desktop <os>. Linux desktop runs on CEF, the others on the system webview.
export function getPlatformLabel(): string {
  const platform = getAppPlatform()
  if (platform === 'tauri-mobile') return 'android'
  if (platform === 'tauri-desktop') {
    const os = detectDesktopOs()
    return os ? `desktop ${os}` : 'desktop'
  }
  return platform
}

// Native shell version from tauri.conf.json; null on web or on failure.
export async function getNativeVersion(): Promise<string | null> {
  if (!isTauriRuntime()) return null
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    return await getVersion()
  } catch {
    return null
  }
}

// Federation /health carries `version`; null when unreachable.
export async function fetchServerVersion(): Promise<string | null> {
  try {
    const res = await fetch(apiUrl('/api/federation/health'))
    if (!res.ok) return null
    const body = await res.json()
    return typeof body?.version === 'string' && body.version ? body.version : null
  } catch {
    return null
  }
}

// `1.6.7 (8b288a24) · desktop linux · app 1.6.6`. Native version appears only when it differs.
export function formatVersionLine(build: BuildInfo, platform: string, nativeVersion: string | null): string {
  const head = build.commit ? `${build.version} (${build.commit})` : build.version
  const parts = [head, platform]
  if (nativeVersion && nativeVersion !== build.version) parts.push(`app ${nativeVersion}`)
  return parts.join(' · ')
}

export interface SupportInfo {
  build: BuildInfo
  platform: string
  nativeVersion: string | null
  instance: string
  serverVersion: string | null
  userAgent: string
}

export function formatSupportText(info: SupportInfo): string {
  const lines = [
    `Version: ${info.build.version}`,
    `Commit: ${info.build.commit || 'unknown'}`,
    `Build date: ${info.build.buildDate || 'unknown'}`,
    `Platform: ${info.platform}`,
  ]
  if (info.nativeVersion) lines.push(`Native app: ${info.nativeVersion}`)
  lines.push(`Instance: ${info.instance}`)
  lines.push(`Server version: ${info.serverVersion || 'unknown'}`)
  if (info.userAgent) lines.push(`User agent: ${info.userAgent}`)
  return lines.join('\n')
}

export async function collectSupportInfo(): Promise<SupportInfo> {
  const [nativeVersion, serverVersion] = await Promise.all([getNativeVersion(), fetchServerVersion()])
  return {
    build: getBuildInfo(),
    platform: getPlatformLabel(),
    nativeVersion,
    instance: getInstanceDomain(),
    serverVersion,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  }
}
