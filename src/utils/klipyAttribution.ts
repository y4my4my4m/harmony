/**
 * Klipy attribution helpers.
 *
 * Messages store GIFs as plain URLs. To keep a link to the GIF's Klipy page on
 * klipy.com (not just the CDN asset), we append a fragment the image loader
 * ignores but our watermark can read back.
 */
import type { Gif } from '@/types'

const KLIPY_ITEM_FRAGMENT = 'harmony-klipy-item'

export function buildGifMessageUrl(gifUrl: string, itemPageUrl?: string | null): string {
  if (!itemPageUrl) return gifUrl
  try {
    const u = new URL(gifUrl)
    u.hash = `${KLIPY_ITEM_FRAGMENT}=${encodeURIComponent(itemPageUrl)}`
    return u.toString()
  } catch {
    return gifUrl
  }
}

/** Strip Harmony's Klipy attribution fragment before using a URL as img/video src. */
export function stripKlipyAttributionFragment(url: string): string {
  try {
    const u = new URL(url)
    if (u.hash.startsWith(`#${KLIPY_ITEM_FRAGMENT}=`)) {
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
  try {
    const u = new URL(mediaUrl)
    const prefix = `#${KLIPY_ITEM_FRAGMENT}=`
    if (!u.hash.startsWith(prefix)) return null
    return decodeURIComponent(u.hash.slice(prefix.length))
  } catch {
    return null
  }
}

/** Fallback Klipy page when we only know it's a Klipy CDN asset (no item page stored). */
export function defaultKlipyHomeUrl(): string {
  return 'https://klipy.com'
}

/** Copy a picker GIF with the message URL (CDN + optional item-page fragment). */
export function withGifMessageUrl(gif: Gif): Gif {
  const url = buildGifMessageUrl(gif.media_formats.gif.url, gif.itemUrl)
  if (url === gif.media_formats.gif.url) return gif
  return {
    ...gif,
    media_formats: {
      ...gif.media_formats,
      gif: { url },
    },
  }
}
