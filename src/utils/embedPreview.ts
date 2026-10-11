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
