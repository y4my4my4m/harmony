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
