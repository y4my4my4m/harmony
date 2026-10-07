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

// render_url of a message's still images: a bounded rendition for consumers with upload limits
// (Discord). The web client downscales the same extensions (src/services/privateMedia.ts).
export const BOT_RENDER_TRANSFORM = { width: 1600, height: 1600, resize: 'contain', quality: 82 } as const
const RENDERABLE_IMAGE = /\.(jpe?g|png)$/i

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

/**
 * Signed URLs of BOT_RENDER_TRANSFORM renditions, by object name; names that fail to sign are
 * absent. Storage signs a transform per object (no batch form).
 */
export async function signMessageMediaRenders(
  paths: string[],
  ttlSeconds: number = BOT_MEDIA_URL_TTL_SECONDS,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const path of new Set(paths)) {
    try {
      const { data, error } = await supabase.storage
        .from(MESSAGE_MEDIA_BUCKET)
        .createSignedUrl(path, ttlSeconds, { transform: { ...BOT_RENDER_TRANSFORM } })
      if (error || !data?.signedUrl) {
        console.warn(`Signing a message media rendition failed: ${error?.message ?? 'no URL'}`)
        continue
      }
      out.set(path, publicStorageUrl(data.signedUrl))
    } catch (error) {
      console.warn('Signing a message media rendition failed:', error)
    }
  }
  return out
}

/**
 * Message content for bots: file parts of the message's room carry a fresh signed `url`; image
 * parts of a .jpg, .jpeg or .png object also carry `render_url`, a signed BOT_RENDER_TRANSFORM
 * rendition, absent when it fails to sign.
 */
export async function withSignedMessageMedia(
  content: unknown,
  message: { channel_id?: string | null; conversation_id?: string | null },
): Promise<unknown> {
  if (!Array.isArray(content)) return content
  const room = messageMediaRoom(message)
  const roomParts = content.filter((part) => part?.type === 'file' && isRoomMediaPath(part.path, room))
  if (roomParts.length === 0) return content
  const renderable = (part: any) => part.fileType === 'image' && RENDERABLE_IMAGE.test(part.path)
  const [signed, renders] = await Promise.all([
    signMessageMediaPaths(roomParts.map((part) => part.path as string)),
    signMessageMediaRenders(roomParts.filter(renderable).map((part) => part.path as string)),
  ])
  return content.map((part) => {
    if (part?.type !== 'file' || !isRoomMediaPath(part.path, room)) return part
    const url = signed.get(part.path)
    const renderUrl = renderable(part) ? renders.get(part.path) : undefined
    return {
      ...part,
      ...(url ? { url } : {}),
      ...(renderUrl ? { render_url: renderUrl } : {}),
    }
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
