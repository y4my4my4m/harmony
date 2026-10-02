import { supabase } from '../config/supabase.js'

/**
 * Chat attachments in the private message_media bucket, for bots.
 *
 * A file part names its object in `path`, `c/<channel id>/...` or `d/<conversation id>/...`
 * (db_schema/migrations/20261006900001_private_user_media.sql). Bots receive such parts with
 * `url` re-signed by the gateway (service role) for BOT_MEDIA_URL_TTL_SECONDS. Paths are
 * signed only inside the message's own room; bots never supply a path.
 */

export const MESSAGE_MEDIA_BUCKET = 'message_media'
export const BOT_MEDIA_URL_TTL_SECONDS = 7 * 24 * 60 * 60

const SIGN_BATCH = 100

/** Room prefix of a message: `c/<channel id>` or `d/<conversation id>`. */
export function messageMediaRoom(message: { channel_id?: string | null; conversation_id?: string | null }): string | null {
  if (message.channel_id) return `c/${String(message.channel_id).toLowerCase()}`
  if (message.conversation_id) return `d/${String(message.conversation_id).toLowerCase()}`
  return null
}

export function isRoomMediaPath(path: unknown, room: string | null): path is string {
  return typeof path === 'string'
    && !!room
    && path.startsWith(`${room}/`)
    && !path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
}

/** Storage URLs as the public reaches them: PUBLIC_URL replaces SUPABASE_URL when both are set. */
export function publicStorageUrl(url: string): string {
  const internal = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
  const publicBase = (process.env.PUBLIC_URL || '').replace(/\/$/, '')
  return internal && publicBase && url.startsWith(internal) ? publicBase + url.slice(internal.length) : url
}

/** Signed URLs for object names, by name; names that fail to sign are absent. */
export async function signMessageMediaPaths(
  paths: string[],
  ttlSeconds: number = BOT_MEDIA_URL_TTL_SECONDS,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(paths)]
  for (let i = 0; i < unique.length; i += SIGN_BATCH) {
    const batch = unique.slice(i, i + SIGN_BATCH)
    const { data, error } = await supabase.storage.from(MESSAGE_MEDIA_BUCKET).createSignedUrls(batch, ttlSeconds)
    if (error) {
      console.error(`Signing message media failed: ${error.message}`)
      continue
    }
    for (const row of data || []) {
      if (row.path && row.signedUrl && !row.error) out.set(row.path, publicStorageUrl(row.signedUrl))
    }
  }
  return out
}

/** Message content for bots: file parts of the message's room carry a fresh signed `url`. */
export async function withSignedMessageMedia(
  content: unknown,
  message: { channel_id?: string | null; conversation_id?: string | null },
): Promise<unknown> {
  if (!Array.isArray(content)) return content
  const room = messageMediaRoom(message)
  const paths = content
    .filter((part) => part?.type === 'file' && isRoomMediaPath(part.path, room))
    .map((part) => part.path as string)
  if (paths.length === 0) return content
  const signed = await signMessageMediaPaths(paths)
  return content.map((part) => {
    if (part?.type !== 'file' || !isRoomMediaPath(part.path, room)) return part
    const url = signed.get(part.path)
    return url ? { ...part, url } : part
  })
}

/** Bot-supplied parts lose `path`: bots name attachments by URL. */
export function stripBotSuppliedPaths(parts: any[]): any[] {
  return parts.map((part) => {
    if (!part || typeof part !== 'object' || !('path' in part)) return part
    const { path: _path, ...rest } = part
    return rest
  })
}
