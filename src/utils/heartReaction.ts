/**
 * The heart reaction is the favourite.
 *
 * Mastodon has no reactions: every Like is a favourite. Misskey stores its like as the
 * reaction U+2764 with variation selectors stripped and maps a bare Like to it. A post holds
 * one heart per actor as a `favorite` row, which fills the heart action and counts in
 * favorites_count; `emoji_reaction` rows are every other emoji and render as chips.
 *
 * Mirrors public.is_heart_reaction and federation-backend/src/utils/heartReaction.ts.
 */

/** U+2764 HEAVY BLACK HEART and U+2665 BLACK HEART SUIT, variation selectors removed. */
const HEART_BASES = new Set(['\u2764', '\u2665'])

/** U+FE0E (text presentation) and U+FE0F (emoji presentation). */
const VARIATION_SELECTORS = /[\uFE0E\uFE0F]/g

/** ❤, ❤️, ❤︎, ♥, ♥️, ♥︎. 💗 and the other coloured hearts are reactions. */
export function isHeartReaction(content: string | null | undefined): boolean {
  if (typeof content !== 'string') return false
  return HEART_BASES.has(content.trim().replace(VARIATION_SELECTORS, ''))
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A picker or chip emoji that is the heart: unicode, no image. The picker sends the
 * character as `id` and leaves `native` unset; a uuid `id` is an emojis row.
 */
export function isHeartEmoji(
  emoji: { native?: string | null; id?: string | null; url?: string | null } | null | undefined,
): boolean {
  if (!emoji || emoji.url) return false
  const content = emoji.native || (emoji.id && !UUID.test(emoji.id) ? emoji.id : null)
  return isHeartReaction(content)
}
