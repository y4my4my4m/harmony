/**
 * Discord custom emoji in Harmony message text.
 *
 * Composer text form: `:discord:<name>:<id>:`, animated `:discord:a:<name>:<id>:`.
 * The static form without colons is the bridge's reaction identifier
 * (custom_emoji_content). A name is 2-32 of [A-Za-z0-9_], so the 4-segment
 * animated form never collides with a static name `a`.
 *
 * The message part mirrors MessageTranslator.contentParts in
 * harmony-discord-bridge (`<:name:id>` / `<a:name:id>`); its emojiText maps
 * domain discord.com + a cdn.discordapp.com/emojis url back to `<:name:id>`.
 */
import type { Emoji } from '@/types'

const NAME = '[A-Za-z0-9_]{2,32}'
const SNOWFLAKE = '\\d{17,20}'

/** Token without the surrounding colons; no capture groups, so it embeds in larger patterns. */
export const DISCORD_EMOJI_TOKEN_INNER = `discord:(?:a:)?${NAME}:${SNOWFLAKE}`

const TOKEN_RE = new RegExp(`^discord:(a:)?(${NAME}):(${SNOWFLAKE})$`)
const NAME_RE = new RegExp(`^${NAME}$`)
const CDN_EMOJI_RE = new RegExp(
  `^https://(?:cdn\\.discordapp\\.com|media\\.discordapp\\.net)/emojis/(${SNOWFLAKE})\\.(png|gif|webp)(?:[?#].*)?$`,
)

export interface DiscordEmojiRef {
  name: string
  /** Discord emoji snowflake. */
  id: string
  animated: boolean
}

/** `discord:[a:]<name>:<id>`, colons stripped; null for anything else. */
export function parseDiscordEmojiToken(token: string): DiscordEmojiRef | null {
  const match = TOKEN_RE.exec(token)
  if (!match) return null
  return { name: match[2], id: match[3], animated: !!match[1] }
}

export function discordEmojiToken(ref: DiscordEmojiRef): string {
  return `discord:${ref.animated ? 'a:' : ''}${ref.name}:${ref.id}`
}

export function discordEmojiCdnUrl(ref: DiscordEmojiRef): string {
  return `https://cdn.discordapp.com/emojis/${ref.id}.${ref.animated ? 'gif' : 'png'}`
}

/** Snowflake and animation of a Discord CDN emoji url; null off cdn.discordapp.com / media.discordapp.net. */
function parseCdnEmojiUrl(url: unknown): { id: string; animated: boolean } | null {
  if (typeof url !== 'string') return null
  const match = CDN_EMOJI_RE.exec(url)
  if (!match) return null
  const animated = match[2] === 'gif' || (match[2] === 'webp' && /[?&]animated=true(?:&|#|$)/.test(url))
  return { id: match[1], animated }
}

/**
 * Discord emoji object of an emoji part. id and server_id are null, as in the
 * bridge's parts; Emoji types them as strings. No `content`: the bridge's
 * emojiText emits a non-empty content verbatim instead of `<:name:id>`.
 */
export function discordEmojiObject(ref: DiscordEmojiRef): Emoji {
  return {
    name: ref.name,
    url: discordEmojiCdnUrl(ref),
    id: null,
    domain: 'discord.com',
    display_name: ref.name,
    server_id: null,
  } as unknown as Emoji
}

/** Discord emoji of a stored emoji part: domain discord.com and a Discord CDN emoji url. */
export function discordEmojiRefFromPart(emoji: unknown): DiscordEmojiRef | null {
  if (!emoji || typeof emoji !== 'object') return null
  const e = emoji as { domain?: unknown; name?: unknown; url?: unknown }
  if (e.domain !== 'discord.com' || typeof e.name !== 'string' || !NAME_RE.test(e.name)) return null
  const cdn = parseCdnEmojiUrl(e.url)
  return cdn ? { name: e.name, id: cdn.id, animated: cdn.animated } : null
}

/**
 * Discord emoji a picker entry stands for: an id or name holding the reaction
 * identifier or token form, else a bridged part's emoji. The static reaction
 * identifier carries no animation; a Discord CDN url of the same snowflake
 * supplies it (reaction metadata.remote_emoji_url is the .gif for animated).
 */
export function discordEmojiRefFromPicked(
  emoji: { id?: unknown; name?: unknown; url?: unknown; domain?: unknown } | null | undefined,
): DiscordEmojiRef | null {
  if (!emoji) return null
  for (const identifier of [emoji.id, emoji.name]) {
    if (typeof identifier !== 'string') continue
    const ref = parseDiscordEmojiToken(identifier)
    if (!ref) continue
    if (ref.animated) return ref
    const cdn = parseCdnEmojiUrl(emoji.url)
    return cdn?.id === ref.id ? { ...ref, animated: cdn.animated } : ref
  }
  return discordEmojiRefFromPart(emoji)
}

/** Composer text of a Discord emoji part, `:discord:[a:]<name>:<id>:`; null for any other emoji. */
export function discordEmojiPartText(emoji: unknown): string | null {
  const ref = discordEmojiRefFromPart(emoji)
  return ref ? `:${discordEmojiToken(ref)}:` : null
}
