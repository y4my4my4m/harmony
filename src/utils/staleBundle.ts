// Desktop update guard. After an auto-update the Windows webview (WebView2) can serve the
// previous version's cached index.html; that page runs without its stylesheet until a manual
// reload (F5). The native shell's version names the bundle that should run: a different
// bundle version reloads once per native version, at a URL the cache has not seen.

export const STALE_RELOAD_KEY = 'harmony:stale-bundle-reload'
export const STALE_RELOAD_PARAM = '_v'

export interface StaleBundleEnv {
  bundleVersion: string
  nativeVersion: () => Promise<string | null>
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  reload: (url: string) => void
}

/** True when a reload was started; the caller stops booting. */
export async function reloadIfStaleBundle(env: StaleBundleEnv): Promise<boolean> {
  if (!env.bundleVersion || env.bundleVersion === 'unknown') return false
  const native = await env.nativeVersion()
  if (!native || native === env.bundleVersion) return false
  try {
    if (env.storage?.getItem(STALE_RELOAD_KEY) === native) return false
    env.storage?.setItem(STALE_RELOAD_KEY, native)
  } catch {
    // Without storage there is no loop guard: no reload.
    return false
  }
  env.reload(`/?${STALE_RELOAD_PARAM}=${encodeURIComponent(native)}`)
  return true
}

/** URL without the cache-busting parameter a stale reload added; null when absent. */
export function withoutStaleParam(href: string): string | null {
  const url = new URL(href)
  if (!url.searchParams.has(STALE_RELOAD_PARAM)) return null
  url.searchParams.delete(STALE_RELOAD_PARAM)
  return `${url.pathname}${url.search}${url.hash}`
}

export const PRELOAD_RELOAD_KEY = 'harmony:preload-reload'
// A second failure of the same bundle within this window reloads nothing: the server still
// serves the files that failed.
export const PRELOAD_RELOAD_WINDOW_MS = 10 * 60 * 1000

/**
 * vite:preloadError guard: a chunk or stylesheet of the loaded bundle that no longer exists (a
 * deploy or desktop update replaced the files under the page) reloads the page once per bundle
 * per PRELOAD_RELOAD_WINDOW_MS. The record holds the bundle and the time, so an earlier reload of
 * the tab (an earlier update, a chunk fetch lost to the network) leaves the next one free.
 * True when the caller reloads; the record is written first.
 */
export function claimPreloadReload(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  bundle: string,
  now: number,
): boolean {
  if (!storage) return false
  try {
    let last: unknown = null
    try {
      last = JSON.parse(storage.getItem(PRELOAD_RELOAD_KEY) ?? 'null')
    } catch {
      last = null
    }
    const rec = last as { bundle?: unknown; at?: unknown } | null
    if (rec && typeof rec === 'object' && rec.bundle === bundle && typeof rec.at === 'number' &&
        now - rec.at >= 0 && now - rec.at < PRELOAD_RELOAD_WINDOW_MS) {
      return false
    }
    storage.setItem(PRELOAD_RELOAD_KEY, JSON.stringify({ bundle, at: now }))
    return true
  } catch {
    // Without storage there is no loop guard: no reload.
    return false
  }
}
