import { publicStorageUrl } from './messageMedia.js'

// Hosts a reaction's metadata.remote_emoji_url may name: Discord's CDN. Clients render the URL
// for every viewer of the message.
const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net'])

/** An https URL on Discord's CDN. */
export function isDiscordCdnUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && DISCORD_CDN_HOSTS.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * emojis.url as consumers outside the instance reach it: an absolute URL with SUPABASE_URL
 * replaced by PUBLIC_URL, or an `emojis` bucket path as its public object URL. Null when absent
 * or when no base is set for a path.
 */
export function absoluteEmojiUrl(url: string | null | undefined): string | null {
  if (!url) return null
  if (url.startsWith('http://') || url.startsWith('https://')) return publicStorageUrl(url)
  const base = (process.env.PUBLIC_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '')
  if (!base) return null
  return `${base}/storage/v1/object/public/emojis/${url.replace(/^\/+/, '')}`
}

/** A .gif image, or a Discord CDN URL asking for the animated rendition (`animated=true`). */
export function isAnimatedEmojiUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return /\.gif$/i.test(parsed.pathname) || parsed.searchParams.get('animated') === 'true'
  } catch {
    return false
  }
}
