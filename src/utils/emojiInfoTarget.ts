/**
 * The emoji an info card is about, from a message part, a reaction pill, or a
 * unicode emoji element of rendered message text.
 *
 *   default   a unicode emoji; glyph is the character sequence
 *   custom    an uploaded or federated emoji; `id` (emojis.id) when it has one,
 *             else the card asks by url. remoteHost: the image's host for a federated
 *             part (`remote:<name>` id) served from another host; the url is already
 *             in the page.
 *   discord   a Discord emoji bridged in by the Discord bridge
 */
import { discordEmojiRefFromPart, discordEmojiRefFromPicked, discordEmojiToken } from '@/utils/discordEmoji'

export type EmojiInfoTarget =
  | { kind: 'default'; glyph: string; shortcode: string | null; imageUrl: string | null }
  | { kind: 'custom'; id: string | null; name: string; url: string; remoteHost?: string | null }
  | { kind: 'discord'; name: string; url: string; token: string }

/** Unicode emoji resolution: shortcode and pack image of a glyph or shortcode. */
export type EmojiResolver = (input: string) => { unicode?: string | null; shortcode?: string | null; imageUrl?: string | null }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UNICODE_EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|‍|️|⃣|[#*0-9])+$/u

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export function isUnicodeEmoji(text: string): boolean {
  return !!text && UNICODE_EMOJI_RE.test(text) && !/^[#*0-9]+$/.test(text)
}

function defaultTarget(input: string, resolve: EmojiResolver): EmojiInfoTarget | null {
  const resolved = resolve(input)
  const glyph = resolved.unicode && isUnicodeEmoji(resolved.unicode) ? resolved.unicode : isUnicodeEmoji(input) ? input : ''
  if (!glyph) return null
  return { kind: 'default', glyph, shortcode: resolved.shortcode || null, imageUrl: resolved.imageUrl || null }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase() || null
  } catch {
    return null
  }
}

/** Emoji of a message `emoji` part ({id, name, url}, or a bridged Discord emoji). */
export function emojiInfoTargetFromPart(
  emoji: unknown,
  localHost: string = globalThis.location?.host ?? '',
): EmojiInfoTarget | null {
  if (!emoji || typeof emoji !== 'object') return null
  const discord = discordEmojiRefFromPart(emoji)
  const e = emoji as { id?: unknown; name?: unknown; url?: unknown }
  if (discord) return { kind: 'discord', name: discord.name, url: str(e.url), token: `:${discordEmojiToken(discord)}:` }
  const url = str(e.url)
  const name = str(e.name)
  if (!url || !name) return null
  const id = str(e.id)
  if (UUID_RE.test(id)) return { kind: 'custom', id, name, url }
  const host = id.startsWith('remote') ? hostOf(url) : null
  return { kind: 'custom', id: null, name, url, remoteHost: host && host !== localHost.toLowerCase() ? host : null }
}

/** Emoji of a reaction pill. */
export function emojiInfoTargetFromReaction(
  group: { emoji_id?: string | null; emoji?: unknown },
  resolve: EmojiResolver,
): EmojiInfoTarget | null {
  const emoji = (group.emoji ?? null) as
    | { id?: unknown; name?: unknown; url?: unknown; content?: unknown; is_native?: boolean; domain?: unknown }
    | null
  const discord = discordEmojiRefFromPicked({
    id: group.emoji_id ?? emoji?.id,
    name: emoji?.name,
    url: emoji?.url,
    domain: emoji?.domain,
  })
  if (discord) {
    return { kind: 'discord', name: discord.name, url: str(emoji?.url), token: `:${discordEmojiToken(discord)}:` }
  }
  const url = str(emoji?.url)
  if (url && emoji?.is_native !== true) {
    const id = str(group.emoji_id) || str(emoji?.id)
    return { kind: 'custom', id: UUID_RE.test(id) ? id : null, name: str(emoji?.name) || 'emoji', url }
  }
  const identifier = str(emoji?.content) || str(emoji?.name) || str(group.emoji_id) || str(emoji?.id)
  return identifier ? defaultTarget(identifier, resolve) : null
}

/** Unicode emoji of rendered message text: an `img.inline-emoji` (alt is the glyph) or a `.native-emoji` span. */
export function emojiInfoTargetFromElement(el: Element, resolve: EmojiResolver): EmojiInfoTarget | null {
  const text = el.tagName === 'IMG' ? el.getAttribute('alt') ?? '' : el.textContent ?? ''
  const glyph = text.trim()
  if (!isUnicodeEmoji(glyph)) return null
  return defaultTarget(glyph, resolve)
}

/** Text a Copy action puts on the clipboard: the glyph, or the composer token. */
export function emojiInfoCopyText(target: EmojiInfoTarget): string {
  if (target.kind === 'default') return target.glyph
  if (target.kind === 'discord') return target.token
  return `:${target.name}:`
}

/** Name shown between colons. */
export function emojiInfoName(target: EmojiInfoTarget): string | null {
  if (target.kind === 'default') return target.shortcode
  return target.name
}
