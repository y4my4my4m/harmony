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
  }
}

function buildParams(opts?: FetchOptions): URLSearchParams {
  const params = new URLSearchParams()
  if (opts?.page) params.set('page', String(opts.page))
  if (opts?.perPage) params.set('per_page', String(opts.perPage))
  if (opts?.locale) params.set('locale', opts.locale)
  return params
}

export const gifProvider = {
  async trending(opts?: FetchOptions): Promise<GifFeed> {
    try {
      return await request('trending', buildParams(opts), opts)
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') debug.error('Failed to fetch trending GIFs:', err)
      return { items: [], page: 1, hasNext: false }
    }
  },

  async search(query: string, opts?: FetchOptions): Promise<GifFeed> {
    const params = buildParams(opts)
    params.set('q', query)
    try {
      return await request('search', params, opts)
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') debug.error('Failed to search GIFs:', err)
      return { items: [], page: 1, hasNext: false }
    }
  },
}

/** Narrowing helper for templates. */
export function isGifItem(item: GifResultItem): item is GifResultItem & { kind: 'gif' } {
  return item.kind === 'gif'
}
