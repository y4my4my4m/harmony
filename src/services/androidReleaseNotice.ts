// "New version available" notice for the Android app, which tauri-plugin-updater
// does not support. Compares the installed version with the latest published
// GitHub release and links to its APK.

import { isTauriRuntime } from '@/services/instanceConfig'
import { isNewerVersion, parseVersion } from '@/utils/appVersion'
import { debug } from '@/utils/debug'

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/y4my4my4m/harmony/releases/latest'
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const CACHE_KEY = 'harmony.androidUpdate.latest'
const DISMISSED_KEY = 'harmony.androidUpdate.dismissedVersion'

export interface AndroidRelease {
  version: string
  // APK asset when the release carries one, otherwise the release page.
  url: string
}

interface CachedRelease {
  checkedAt: number
  release: AndroidRelease | null
}

export function isAndroidApp(): boolean {
  return isTauriRuntime() && typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
}

// GitHub REST `GET /repos/{owner}/{repo}/releases/latest` body.
export function parseLatestRelease(body: unknown): AndroidRelease | null {
  if (!body || typeof body !== 'object') return null
  const release = body as {
    tag_name?: unknown
    html_url?: unknown
    draft?: unknown
    prerelease?: unknown
    assets?: unknown
  }
  if (release.draft === true || release.prerelease === true) return null
  if (typeof release.tag_name !== 'string') return null
  const parsed = parseVersion(release.tag_name)
  if (!parsed) return null

  const assets = Array.isArray(release.assets) ? release.assets : []
  const apk = assets.find(
    (a): a is { name: string; browser_download_url: string } =>
      !!a &&
      typeof a.name === 'string' &&
      typeof a.browser_download_url === 'string' &&
      a.name.toLowerCase().endsWith('.apk'),
  )
  const url = apk?.browser_download_url ?? (typeof release.html_url === 'string' ? release.html_url : null)
  if (!url || !/^https:\/\//i.test(url)) return null
  return { version: parsed.join('.'), url }
}

function readCache(): CachedRelease | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedRelease
    return typeof parsed?.checkedAt === 'number' ? parsed : null
  } catch {
    return null
  }
}

function writeCache(entry: CachedRelease): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry))
  } catch {
    /* re-fetched next launch */
  }
}

export function isDismissed(version: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === version
  } catch {
    return false
  }
}

export function dismissVersion(version: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, version)
  } catch {
    /* notice returns next launch */
  }
}

// Latest release, fetched at most once per CHECK_INTERVAL_MS; failures are
// cached too, so an offline device does not retry on every launch.
export async function getLatestRelease(now = Date.now()): Promise<AndroidRelease | null> {
  const cached = readCache()
  if (cached && now - cached.checkedAt < CHECK_INTERVAL_MS) return cached.release

  let release: AndroidRelease | null = null
  try {
    const response = await fetch(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (response.ok) release = parseLatestRelease(await response.json())
  } catch (error) {
    debug.warn('[androidReleaseNotice] release check failed:', error)
  }
  writeCache({ checkedAt: now, release })
  return release
}

// The release to announce, or null when current, dismissed or unknown.
export async function findAndroidUpdate(): Promise<AndroidRelease | null> {
  if (!isAndroidApp()) return null
  let current: string
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    current = await getVersion()
  } catch {
    return null
  }
  const latest = await getLatestRelease()
  if (!latest || !isNewerVersion(latest.version, current) || isDismissed(latest.version)) return null
  return latest
}
