import { supabase } from '../config/supabase.js'
import { absoluteEmojiUrl } from './emojiUrl.js'

export const EMOJI_BUCKET = 'emojis'
/** Discord caps custom emoji at 256 KiB; the margin covers re-encoding on their CDN. */
export const MAX_DISCORD_EMOJI_BYTES = 512 * 1024
export const DISCORD_EMOJI_ID = /^[0-9]{1,20}$/
export const EMOJI_NAME = /^[A-Za-z0-9_]{1,32}$/

/** CDN URL built from the id alone; no caller-supplied URL is fetched. */
export function discordEmojiCdnUrl(discordEmojiId: string, animated: boolean): string {
  return `https://cdn.discordapp.com/emojis/${discordEmojiId}.${animated ? 'gif' : 'png'}`
}

/** emojis bucket path of an imported Discord emoji; one object per server and Discord emoji. */
export function discordEmojiStoragePath(serverId: string, discordEmojiId: string, animated: boolean): string {
  return `${serverId}/discord/${discordEmojiId}.${animated ? 'gif' : 'png'}`
}

/**
 * Copies a Discord emoji image into the emojis bucket and answers its public URL.
 * Throws on a non-image response, an oversize body, or a storage error.
 */
export async function storeDiscordEmojiImage(
  serverId: string,
  discordEmojiId: string,
  animated: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(discordEmojiCdnUrl(discordEmojiId, animated))
  if (!response.ok) throw new Error(`Discord CDN answered ${response.status}`)
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!type.startsWith('image/')) throw new Error(`Discord CDN answered ${type || 'no content type'}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_DISCORD_EMOJI_BYTES) {
    throw new Error(`emoji image is ${buffer.byteLength} bytes`)
  }

  const path = discordEmojiStoragePath(serverId, discordEmojiId, animated)
  const { error } = await supabase.storage.from(EMOJI_BUCKET).upload(path, buffer, {
    contentType: type,
    upsert: true,
    cacheControl: '31536000',
  })
  if (error) throw new Error(`storage upload failed: ${error.message}`)

  const url = absoluteEmojiUrl(path)
  if (!url) throw new Error('PUBLIC_URL or SUPABASE_URL is not set')
  return url
}
