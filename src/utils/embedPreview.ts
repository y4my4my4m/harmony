import type { EmbedPayload } from '@/types'

/**
 * A preview with nothing to show beyond its own URL: the page could not be read (`failed`, or
 * a payload stored before that flag, whose title is the URL and whose description held the
 * error), or it carries no title, image, video or player. Such previews render no card.
 */
export function isEmptyPreview(payload: EmbedPayload | null | undefined): boolean {
  if (!payload) return true
  if (payload.failed) return true
  if (payload.provider !== 'generic') return false
  if (payload.image || payload.video?.url || payload.html) return false
  const title = (payload.title ?? '').trim()
  return !title || title === payload.url || title === payload.normalizedUrl
}

// Mirrors WIKIMEDIA_HOST in federation-backend/src/services/LinkPreviewService.ts.
const WIKIMEDIA_HOST = /(^|\.)(wikipedia|wikimedia|wiktionary|wikiquote|wikibooks|wikisource|wikivoyage|wikinews|wikiversity|wikidata)\.org$/

/**
 * A Wikimedia page. Its projects store still photos as GIF, so a .gif preview image there is no
 * GIF page; previews stored with mediaOnly from that heuristic still render as cards.
 */
export function isWikimediaPage(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    return WIKIMEDIA_HOST.test(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}
