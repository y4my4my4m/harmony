// Spoken names for emoji. Shortcodes are snake_case ("thumbs_up",
// "grinning_face"); screen readers spell the underscores, so accessible names
// use the words. Custom emoji keep their :name: form, which is how people type
// and recognise them.

/** "thumbs_up", ":thumbs-up:" -> "thumbs up". Returns '' for an empty name. */
export function humanizeEmojiName(name: string | null | undefined): string {
  if (!name) return ''
  return name
    .trim()
    .replace(/^:+|:+$/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** ":party_parrot:" for a custom emoji name. */
export function customEmojiLabel(name: string | null | undefined): string {
  const bare = (name ?? '').trim().replace(/^:+|:+$/g, '')
  return bare ? `:${bare}:` : ''
}

export interface SpokenEmoji {
  /** Present for custom (image) emoji. */
  url?: string | null
  name?: string | null
  /** Unicode shortcode, when resolved. */
  shortcode?: string | null
  /** Unicode character. */
  native?: string | null
  is_native?: boolean
}

/**
 * Accessible name of one emoji: :name: for a custom emoji, the humanized
 * shortcode for a Unicode one, else its character.
 */
export function spokenEmojiName(emoji: SpokenEmoji | null | undefined): string {
  if (!emoji) return ''
  if (emoji.url && !emoji.is_native) return customEmojiLabel(emoji.name)
  return humanizeEmojiName(emoji.shortcode) || humanizeEmojiName(isWordy(emoji.name) ? emoji.name : '') || emoji.native || emoji.name || ''
}

/** True when the name is a word, not the emoji character itself. */
function isWordy(name: string | null | undefined): boolean {
  return !!name && /[a-z0-9]/i.test(name)
}
