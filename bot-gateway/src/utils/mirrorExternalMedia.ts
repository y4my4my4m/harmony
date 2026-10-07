import { randomUUID } from 'crypto'
import { supabase } from '../config/supabase.js'
import { MESSAGE_MEDIA_BUCKET, signMessageMediaPaths } from './messageMedia.js'

const MAX_BYTES = 50 * 1024 * 1024

const ALLOWED_HOST_SUFFIXES = ['discordapp.com', 'discordapp.net']

function isAllowedSourceUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))
  } catch {
    return false
  }
}

/** A message content array has at least one Discord-CDN file part (refresh candidate). */
export function hasDiscordCdnFilePart(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some(
    (p) =>
      (p?.type === 'file' || p?.type === 'url') &&
      typeof p.url === 'string' &&
      isAllowedSourceUrl(p.url),
  )
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * An animated PNG: an acTL chunk precedes the first IDAT (APNG specification). Discord serves
 * APNG stickers and attachments as image/png with a .png name. Chunk layout: 4-byte big-endian
 * data length, 4-byte type, data, 4-byte CRC.
 */
export function isAnimatedPng(buffer: Buffer): boolean {
  if (buffer.byteLength < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return false
  let offset = 8
  while (offset + 8 <= buffer.byteLength) {
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    if (type === 'acTL') return true
    if (type === 'IDAT' || type === 'IEND') return false
    offset += 12 + buffer.readUInt32BE(offset)
  }
  return false
}

function fileTypeOf(contentType: string): 'image' | 'video' | 'audio' | 'file' {
  if (contentType.startsWith('image/')) return 'image'
  if (contentType.startsWith('video/')) return 'video'
  if (contentType.startsWith('audio/')) return 'audio'
  return 'file'
}

function extensionFrom(fileName: string | undefined, contentType: string | undefined, sourceUrl: string): string {
  const fromName = fileName?.split('.').pop()?.toLowerCase()
  if (fromName && /^[a-z0-9]{1,8}$/.test(fromName)) return fromName
  if (contentType?.includes('png')) return 'png'
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return 'jpg'
  if (contentType?.includes('gif')) return 'gif'
  if (contentType?.includes('webp')) return 'webp'
  if (contentType?.includes('mp4')) return 'mp4'
  const fromUrl = sourceUrl.split('?')[0].split('.').pop()?.toLowerCase()
  if (fromUrl && /^[a-z0-9]{1,8}$/.test(fromUrl)) return fromUrl
  return 'bin'
}

/** Unsigned reference to an object; resolves for nobody without a bearer token. */
function referenceUrl(storagePath: string): string {
  const publicBase = (process.env.PUBLIC_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '')
  return `${publicBase}/storage/v1/object/authenticated/${MESSAGE_MEDIA_BUCKET}/${storagePath}`
}

/**
 * Copies a Discord CDN attachment into the channel's room of message_media, as
 * c/<channel id>/bridge/<bot id>/<uuid>.<ext>. The returned url is signed for clients
 * before 1.6.6, which render `url`.
 */
export async function mirrorExternalMediaToStorage(
  sourceUrl: string,
  opts: { botId: string; channelId: string; fileName?: string; contentType?: string },
): Promise<{ path: string; url: string; contentType: string }> {
  if (!isAllowedSourceUrl(sourceUrl)) {
    throw new Error(`Refusing to mirror disallowed URL host`)
  }

  const response = await fetch(sourceUrl)
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(`Attachment too large (${buffer.byteLength} bytes)`)
  }

  // An APNG stored as .png is served as a static thumbnail: clients downscale .png only.
  const animatedPng = isAnimatedPng(buffer)
  const contentType = animatedPng
    ? 'image/apng'
    : opts.contentType || response.headers.get('content-type') || 'application/octet-stream'
  const extension = animatedPng ? 'apng' : extensionFrom(opts.fileName, contentType, sourceUrl)

  const storagePath = `c/${opts.channelId.toLowerCase()}/bridge/${opts.botId}/${randomUUID()}.${extension}`
  const { error } = await supabase.storage.from(MESSAGE_MEDIA_BUCKET).upload(storagePath, buffer, {
    contentType,
    upsert: false,
    cacheControl: '31536000',
  })
  if (error) throw new Error(`Storage upload failed: ${error.message}`)

  const signed = await signMessageMediaPaths([storagePath])
  return { path: storagePath, url: signed.get(storagePath) ?? referenceUrl(storagePath), contentType }
}

/**
 * Apply the instance-wide bridge attachment policy to a message's content parts.
 * In `mirror` mode, Discord CDN file parts are copied into the channel's room of
 * message_media and carry its path. Any other mode (or a mirror failure) leaves the
 * original URL untouched. Resolved server-side so bridge bots never need to know the
 * instance policy.
 */
export async function applyBridgeAttachmentPolicy(
  parts: any[],
  botId: string,
  channelId: string,
): Promise<any[]> {
  if (!Array.isArray(parts) || parts.length === 0) return parts

  const mode = await getBridgeAttachmentMode()
  if (mode !== 'mirror') return parts

  const out: any[] = []
  for (const part of parts) {
    const url = part?.url
    if (
      (part?.type !== 'file' && part?.type !== 'url') ||
      typeof url !== 'string' ||
      !isAllowedSourceUrl(url)
    ) {
      out.push(part)
      continue
    }
    try {
      const mirrored = await mirrorExternalMediaToStorage(url, {
        botId,
        channelId,
        fileName: typeof part.fileName === 'string' ? part.fileName : undefined,
        contentType: typeof part.contentType === 'string' ? part.contentType : undefined,
      })
      // A mirrored attachment is a file part: only file parts carry a path.
      out.push({
        ...part,
        type: 'file',
        fileType: part.fileType ?? fileTypeOf(mirrored.contentType),
        url: mirrored.url,
        path: mirrored.path,
      })
    } catch (error: any) {
      console.error(`Mirror failed, keeping Discord URL: ${error?.message || error}`)
      out.push(part)
    }
  }
  return out
}

export type BridgeAttachmentMode = 'link' | 'refresh' | 'mirror'

export async function getBridgeAttachmentMode(): Promise<BridgeAttachmentMode> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_value')
    .eq('config_key', 'bridge_attachment_mode')
    .maybeSingle()

  if (error || !data?.config_value) return 'link'

  let raw = data.config_value
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { /* plain string */ }
  }
  const mode = String(raw).replace(/^"|"$/g, '')
  if (mode === 'refresh' || mode === 'mirror') return mode
  return 'link'
}
