/**
 * Klipy attribution helpers.
 *
 * Messages store GIFs/stickers/clips/memes/AI-emojis as plain media URLs. We
 * append a URL fragment the loader ignores but our renderer reads back, carrying:
 *   - `item` : the media's Klipy page (klipy.com/...) for the optional watermark link.
 *   - `kind` : 'sticker' | 'clip' | 'meme' | 'ai-emoji' (absent ⇒ 'gif').
 *
 * Format: `#harmony-klipy=item%3D...%26kind%3Dclip` (a urlencoded querystring).
 */
import type { Gif } from '@/types'
import type { GifMediaType } from '@/services/gifProviderService'

const KLIPY_FRAGMENT = 'harmony-klipy'

/** Official KLIPY wordmark for the optional on-media watermark overlay. */
export const KLIPY_WATERMARK_LOGO_URL = '/assets/3rdparty/KLIPY_TEXT_LIGHT.svg'

export type KlipyKind = 'gif' | 'sticker' | 'clip' | 'meme' | 'ai-emoji'

/** Map the picker's media type to the compact kind stored on the message URL. */
export function mediaTypeToKind(mediaType: GifMediaType): KlipyKind {
  switch (mediaType) {
    case 'stickers': return 'sticker'
    case 'clips': return 'clip'
    case 'memes': return 'meme'
    case 'ai-emojis': return 'ai-emoji'
    default: return 'gif'
  }
}

export interface BuildOptions {
  itemPageUrl?: string | null
  kind?: KlipyKind
}

export function buildGifMessageUrl(gifUrl: string, opts?: BuildOptions): string {
  const itemPageUrl = opts?.itemPageUrl
  const kind = opts?.kind && opts.kind !== 'gif' ? opts.kind : undefined
  if (!itemPageUrl && !kind) return gifUrl
  try {
    const u = new URL(gifUrl)
    const params = new URLSearchParams()
    if (itemPageUrl) params.set('item', itemPageUrl)
    if (kind) params.set('kind', kind)
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

/** The Klipy kind tagged on a message media URL ('gif' when untagged). */
export function parseKlipyKind(mediaUrl: string): KlipyKind {
  const k = readFragment(mediaUrl)?.get('kind')
  if (k === 'sticker' || k === 'clip' || k === 'meme' || k === 'ai-emoji') return k
  return 'gif'
}

/** Small, sticker-like media (stickers + AI emojis): rendered tiny, no lightbox. */
export function isStickerMessageUrl(mediaUrl: string): boolean {
  const k = parseKlipyKind(mediaUrl)
  return k === 'sticker' || k === 'ai-emoji'
}

/**
 * Klipy AI emoji - these ARE emoji, so they render exactly like one: emoji-sized,
 * inline, no lightbox, no favorite affordance, and no KLIPY watermark.
 */
export function isAiEmojiMessageUrl(mediaUrl: string): boolean {
  return parseKlipyKind(mediaUrl) === 'ai-emoji'
}

/** Clip media - rendered/sent as a video. */
export function isVideoMessageUrl(mediaUrl: string): boolean {
  return parseKlipyKind(mediaUrl) === 'clip'
}

/** Fallback Klipy page when we only know it's a Klipy CDN asset (no item page stored). */
export function defaultKlipyHomeUrl(): string {
  return 'https://klipy.com'
}

/** Copy a picker item with the message URL (CDN + optional metadata). */
export function withGifMessageUrl(gif: Gif, kind: KlipyKind = 'gif'): Gif {
  const url = buildGifMessageUrl(gif.media_formats.gif.url, {
    itemPageUrl: gif.itemUrl,
    kind,
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
