/**
 * Klipy attribution helpers.
 *
 * Messages store GIFs/stickers as plain image URLs. We append a URL fragment
 * the image loader ignores but our renderer can read back, carrying two bits of
 * metadata:
 *   - `item`    : the GIF/sticker's Klipy page (klipy.com/...) for the optional
 *                 attribution watermark link.
 *   - `sticker` : whether this media is a sticker (rendered small, no lightbox).
 *
 * Format: `#harmony-klipy=item%3D...%26sticker%3D1` (a urlencoded querystring).
 */
import type { Gif } from '@/types'

const KLIPY_FRAGMENT = 'harmony-klipy'

export interface KlipyMeta {
  itemPageUrl?: string
  isSticker: boolean
}

export interface BuildOptions {
  itemPageUrl?: string | null
  isSticker?: boolean
}

export function buildGifMessageUrl(gifUrl: string, opts?: BuildOptions): string {
  const itemPageUrl = opts?.itemPageUrl
  const isSticker = opts?.isSticker
  if (!itemPageUrl && !isSticker) return gifUrl
  try {
    const u = new URL(gifUrl)
    const params = new URLSearchParams()
    if (itemPageUrl) params.set('item', itemPageUrl)
    if (isSticker) params.set('sticker', '1')
    const encoded = params.toString()
    if (!encoded) return gifUrl
    u.hash = `${KLIPY_FRAGMENT}=${encoded}`
    return u.toString()
  } catch {
    return gifUrl
  }
}

function readFragment(url: string): URLSearchParams | null {
  try {
    const u = new URL(url)
    const prefix = `#${KLIPY_FRAGMENT}=`
    if (!u.hash.startsWith(prefix)) return null
    return new URLSearchParams(u.hash.slice(prefix.length))
  } catch {
    return null
  }
}

/** Strip Harmony's Klipy attribution fragment before using a URL as img/video src. */
export function stripKlipyAttributionFragment(url: string): string {
  try {
    const u = new URL(url)
    if (u.hash.startsWith(`#${KLIPY_FRAGMENT}=`)) {
      u.hash = ''
      return u.toString()
    }
  } catch {
    // not a full URL
  }
  return url
}

/** Read the Klipy item page URL embedded in a message media URL, if any. */
export function parseKlipyItemPageUrl(mediaUrl: string): string | null {
  return readFragment(mediaUrl)?.get('item') || null
}

/** True when this message media URL was tagged as a Klipy sticker. */
export function isStickerMessageUrl(mediaUrl: string): boolean {
  return readFragment(mediaUrl)?.get('sticker') === '1'
}

/** Fallback Klipy page when we only know it's a Klipy CDN asset (no item page stored). */
export function defaultKlipyHomeUrl(): string {
  return 'https://klipy.com'
}

/** Copy a picker GIF/sticker with the message URL (CDN + optional metadata). */
export function withGifMessageUrl(gif: Gif, isSticker = false): Gif {
  const url = buildGifMessageUrl(gif.media_formats.gif.url, {
    itemPageUrl: gif.itemUrl,
    isSticker,
  })
  if (url === gif.media_formats.gif.url) return gif
  return {
    ...gif,
    media_formats: {
      ...gif.media_formats,
      gif: { url },
    },
  }
}
