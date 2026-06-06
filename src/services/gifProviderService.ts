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
import type { GifResultItem } from '@/types'

const FEDERATION_API = '/api/federation'

export interface GifFeed {
  items: GifResultItem[]
  page: number
  hasNext: boolean
  meta?: { showAds?: boolean }
}

interface FetchOptions {
  page?: number
  perPage?: number
  locale?: string
  signal?: AbortSignal
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function request(path: string, params: URLSearchParams, opts?: FetchOptions): Promise<GifFeed> {
  const headers = { Accept: 'application/json', ...(await authHeaders()) }
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

function buildParams(opts?: FetchOptions): URLSearchParams {
  const params = new URLSearchParams()
  if (opts?.page) params.set('page', String(opts.page))
  if (opts?.perPage) params.set('per_page', String(opts.perPage))
  if (opts?.locale) params.set('locale', opts.locale)
  return params
}

export type GifMediaType = 'gifs' | 'stickers' | 'clips' | 'memes' | 'ai-emojis'

/** Backend path prefix for a media type. GIFs sit at the proxy root for back-compat. */
function pathPrefix(mediaType: GifMediaType): string {
  return mediaType === 'gifs' ? '' : `${mediaType}/`
}

export const gifProvider = {
  async trending(opts?: FetchOptions, mediaType: GifMediaType = 'gifs'): Promise<GifFeed> {
    try {
      return await request(`${pathPrefix(mediaType)}trending`, buildParams(opts), opts)
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') debug.error(`Failed to fetch trending ${mediaType}:`, err)
      return { items: [], page: 1, hasNext: false }
    }
  },

  async search(query: string, opts?: FetchOptions, mediaType: GifMediaType = 'gifs'): Promise<GifFeed> {
    const params = buildParams(opts)
    params.set('q', query)
    try {
      return await request(`${pathPrefix(mediaType)}search`, params, opts)
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') debug.error(`Failed to search ${mediaType}:`, err)
      return { items: [], page: 1, hasNext: false }
    }
  },

  /** Klipy search suggestions (no query) / autocomplete (with query). Best-effort. */
  async suggest(query: string | undefined, opts?: FetchOptions): Promise<string[]> {
    const params = new URLSearchParams()
    if (query?.trim()) params.set('q', query.trim())
    if (opts?.locale) params.set('locale', opts.locale)
    try {
      const headers = { Accept: 'application/json', ...(await authHeaders()) }
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
