/**
 * gifProviderService - frontend client for the backend GIF proxy (Klipy)
 *
 * The browser never talks to Klipy directly and never holds a key. It calls the
 * authenticated federation-backend proxy, which selects the ad-enabled or
 * ad-free Klipy key based on the viewer's supporter tier. The response is a
 * normalized feed of GIF items and (for ad-eligible viewers) ad items.
 *
 * Centralizing the fetch here keeps the pickers DRY: GifPickerContent and
 * InlineGifPicker share one code path for trending/search.
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { collectKlipyAdContext } from '@/utils/klipyAdContext'
import { isMobileUserAgent } from '@/utils/pwaUtils'
import type { GifResultItem } from '@/types'

const FEDERATION_API = '/api/federation'

export interface GifFeed {
  items: GifResultItem[]
  page: number
  hasNext: boolean
  meta?: {
    showAds?: boolean
    adMobileOnly?: boolean
    adPlatformEligible?: boolean
    adTierEligible?: boolean
  }
}

export interface GifFetchOptions {
  page?: number
  perPage?: number
  locale?: string
  signal?: AbortSignal
  /** Width of the ad tile in px (picker strip or popup). Improves Klipy size matching. */
  adSlotWidth?: number
}

async function clientHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  // Klipy ad fill uses the end-user UA; pass explicitly so it survives the proxy hop.
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    headers['X-Client-User-Agent'] = navigator.userAgent
  }
  return headers
}

async function request(path: string, params: URLSearchParams, opts?: GifFetchOptions): Promise<GifFeed> {
  const headers = { Accept: 'application/json', ...(await clientHeaders()) }
  const res = await fetch(`${FEDERATION_API}/gifs/${path}?${params}`, {
    method: 'GET',
    headers,
    signal: opts?.signal,
  })
  if (!res.ok) {
    throw new Error(`GIF request failed (${res.status})`)
  }
  const data = await res.json()
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    page: Number(data?.page) || 1,
    hasNext: Boolean(data?.hasNext),
    meta: data?.meta,
  }
}

function buildParams(opts?: GifFetchOptions, mediaType: GifMediaType = 'gifs'): URLSearchParams {
  const params = new URLSearchParams()
  if (opts?.page) params.set('page', String(opts.page))
  if (opts?.perPage) params.set('per_page', String(opts.perPage))
  if (opts?.locale) params.set('locale', opts.locale)
  // Klipy ad params apply to the GIF feed only (ads are disabled for other media).
  if (mediaType === 'gifs' && typeof window !== 'undefined' && isMobileUserAgent()) {
    for (const [key, value] of Object.entries(collectKlipyAdContext(opts?.adSlotWidth).params)) {
      params.set(key, value)
    }
  }
  return params
}

export type GifMediaType = 'gifs' | 'stickers' | 'clips' | 'memes' | 'ai-emojis'

/** Backend path prefix for a media type. GIFs sit at the proxy root for back-compat. */
function pathPrefix(mediaType: GifMediaType): string {
  return mediaType === 'gifs' ? '' : `${mediaType}/`
}

export const gifProvider = {
  async trending(opts?: GifFetchOptions, mediaType: GifMediaType = 'gifs'): Promise<GifFeed> {
    try {
      return await request(`${pathPrefix(mediaType)}trending`, buildParams(opts, mediaType), opts)
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') debug.error(`Failed to fetch trending ${mediaType}:`, err)
      return { items: [], page: 1, hasNext: false }
    }
  },

  async search(query: string, opts?: GifFetchOptions, mediaType: GifMediaType = 'gifs'): Promise<GifFeed> {
    const params = buildParams(opts, mediaType)
    params.set('q', query)
    try {
      return await request(`${pathPrefix(mediaType)}search`, params, opts)
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') debug.error(`Failed to search ${mediaType}:`, err)
      return { items: [], page: 1, hasNext: false }
    }
  },

  /** Klipy search suggestions (no query) / autocomplete (with query). Best-effort. */
  async suggest(query: string | undefined, opts?: GifFetchOptions): Promise<string[]> {
    const params = new URLSearchParams()
    if (query?.trim()) params.set('q', query.trim())
    if (opts?.locale) params.set('locale', opts.locale)
    try {
      const headers = { Accept: 'application/json', ...(await clientHeaders()) }
      const res = await fetch(`${FEDERATION_API}/gifs/suggest?${params}`, {
        method: 'GET',
        headers,
        signal: opts?.signal,
      })
      if (!res.ok) return []
      const data = await res.json()
      return Array.isArray(data?.suggestions) ? data.suggestions : []
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') debug.error('Failed to fetch GIF suggestions:', err)
      return []
    }
  },
}

/** Narrowing helper for templates. */
export function isGifItem(item: GifResultItem): item is GifResultItem & { kind: 'gif' } {
  return item.kind === 'gif'
}
