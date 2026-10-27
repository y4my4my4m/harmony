import type { EmbedPayload } from '@/types'
import { isWikimediaPage } from '@/utils/embedPreview'

/**
 * Hosts whose pages each hold one GIF, the page's whole preview. Mirrors GIF_PAGE_HOSTS in
 * federation-backend/src/services/LinkPreviewService.ts.
 */
const GIF_PAGE_HOSTS: readonly string[] = ['klipy.com', 'tenor.com', 'giphy.com']

/** A page on a GIF host (klipy.com/gifs/..., tenor.com/view/..., giphy.com/gifs/...). */
export function isGifPageUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    return GIF_PAGE_HOSTS.includes(parsed.hostname.toLowerCase().replace(/^www\./, ''))
  } catch {
    return false
  }
}

/**
 * How a link preview renders in place of a link card:
 *   image  a GIF page's GIF, or any preview marked mediaOnly
 *   video  a GIF page's looping MP4/WebM
 *   clip   the video the link answered with (embed-fixer sites), in a player
 */
export interface LinkPreviewMedia {
  kind: 'image' | 'video' | 'clip'
  url: string
}

/**
 * The media a preview renders as, or null for a link card. Decided from the media file
 * extension as well as mediaOnly: previews persist in message metadata, so payloads stored
 * before the backend set the flag still render as media.
 */
export function linkPreviewMedia(payload: EmbedPayload | null | undefined): LinkPreviewMedia | null {
  if (!payload || isWikimediaPage(payload.url)) return null
  if (payload.mediaOnly && payload.video?.url) return { kind: 'clip', url: payload.video.url }
  const media = payload.image
  if (!media) return null
  if (/\.(mp4|webm|mov)(\?|#|$)/i.test(media)) return { kind: 'video', url: media }
  if (payload.mediaOnly || /\.gif(\?|#|$)/i.test(media)) return { kind: 'image', url: media }
  return null
}

type PartLike = { type?: unknown; url?: unknown; text?: unknown; preview?: unknown } | null | undefined

/**
 * The url part that is the whole of `parts` and shows as a GIF alone: a link to a GIF page,
 * preview on, whose media (`mediaOf`) renders as a GIF (image, or looping video), with nothing
 * beside it but whitespace. Its text is not shown, as Discord drops a lone GIF link.
 */
export function soleGifLinkPart<T>(
  parts: readonly T[] | null | undefined,
  mediaOf: (part: T) => LinkPreviewMedia | null,
): T | null {
  if (!Array.isArray(parts)) return null
  let link: T | null = null
  for (const part of parts) {
    const p = part as PartLike
    if (p?.type === 'text' && !String(p.text ?? '').trim()) continue
    if (link !== null || p?.type !== 'url' || typeof p.url !== 'string') return null
    if (p.preview === false || p.preview === 'false' || !isGifPageUrl(p.url)) return null
    const kind = mediaOf(part)?.kind
    if (kind !== 'image' && kind !== 'video') return null
    link = part
  }
  return link
}
