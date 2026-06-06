/**
 * Ephemeral (URL-based) emoji helpers for Klipy browse "AI Emoji".
 *
 * A browsed Klipy AI emoji is NOT hosted on this instance and has no
 * `public.emojis` row. We treat it like a remote/federated emoji: it carries a
 * plain CDN URL end-to-end. To make it usable as a normal custom emoji in the
 * composer (insert as `:shortcode:`, render as an emoji tag, count in
 * frequently-used), we register it in the in-memory emoji cache for the session
 * so the `:shortcode:` resolves at send time and bakes the URL into the message.
 */
import type { Gif, Emoji } from '@/types'
import { stripKlipyAttributionFragment } from '@/utils/klipyAttribution'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'

/** Session-scoped synthetic cache group key for browsed Klipy AI emoji. */
export const KLIPY_EPHEMERAL_GROUP = '__klipy_ephemeral__'

/** Short, stable base36 hash of a string (for shortcode uniqueness). */
function shortHash(input: string): string {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(31, h) + input.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36).slice(0, 4)
}

/** Slugify a title into a safe emoji shortcode body: [a-z0-9_], trimmed. */
function slugify(raw: string | undefined): string {
  const base = (raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
  return base || 'emoji'
}

/**
 * Build an `Emoji` for a browsed Klipy AI emoji. `id` and `url` are the CDN
 * image (without our attribution fragment); `name` is a unique shortcode so it
 * can never collide with a real custom emoji or another ephemeral one.
 */
export function buildEphemeralEmojiFromGif(gif: Gif): Emoji {
  const url = stripKlipyAttributionFragment(gif.media_formats?.gif?.url || '')
  const name = `${slugify(gif.title)}_${shortHash(url)}`
  return {
    id: url,
    name,
    url,
    created_at: new Date(),
  }
}

/**
 * Register an ephemeral emoji in the session cache so `:shortcode:` resolves to
 * it at send time. Idempotent: re-registering the same URL is a no-op upsert.
 */
export function registerEphemeralEmoji(emoji: Emoji): void {
  const cache = useEmojiCacheStore()
  cache.addPersonalEmoji(KLIPY_EPHEMERAL_GROUP, 'Recent', emoji)
}
