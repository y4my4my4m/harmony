import { supabase } from '../config/supabase.js'
import { MESSAGE_MEDIA_BUCKET } from './messageMedia.js'
import { mirrorFileToStorage } from './mirrorFile.js'

const ALLOWED_HOST_SUFFIXES = ['discordapp.com', 'discordapp.net']

/** An http(s) URL on discordapp.com, discordapp.net or a subdomain of either. */
export function isAllowedSourceUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    if (protocol !== 'https:' && protocol !== 'http:') return false
    const host = hostname.toLowerCase()
    return ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))
  } catch {
    return false
  }
}

/**
 * bridge_mirror_allows: the server of `channelId` holds `bytes` more of mirrored files within
 * instance_config.bridge_mirror_server_limit_mb. Throws when the answer cannot be read, so a
 * failed read stores nothing.
 */
export async function mirrorAllows(channelId: string, bytes: number): Promise<boolean> {
  const { data, error } = await supabase.rpc('bridge_mirror_allows', { p_channel_id: channelId, p_bytes: bytes })
  if (error) throw new Error(`bridge_mirror_allows failed: ${error.message}`)
  return data === true
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

export function fileTypeOf(contentType: string): 'image' | 'video' | 'audio' | 'file' {
  if (contentType.startsWith('image/')) return 'image'
  if (contentType.startsWith('video/')) return 'video'
  if (contentType.startsWith('audio/')) return 'audio'
  return 'file'
}

export function extensionFrom(fileName: string | undefined, contentType: string | undefined, sourceUrl: string): string {
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
export function referenceUrl(storagePath: string): string {
  const publicBase = (process.env.PUBLIC_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '')
  return `${publicBase}/storage/v1/object/authenticated/${MESSAGE_MEDIA_BUCKET}/${storagePath}`
}

/**
 * Copies a Discord CDN attachment into the channel's room of message_media, as
 * c/<channel id>/bridge/<bot id>/<uuid>.<ext>, up to the instance upload ceiling. The returned
 * url is signed for clients before 1.6.6, which render `url`.
 */
export async function mirrorExternalMediaToStorage(
  sourceUrl: string,
  opts: { botId: string; channelId: string; fileName?: string; contentType?: string },
): Promise<{ path: string; url: string; contentType: string }> {
  const { path, url, contentType } = await mirrorFileToStorage(sourceUrl, {
    ...opts,
    ceiling: await getUploadCeilingBytes(),
  })
  return { path, url, contentType }
}

const DEFAULT_UPLOAD_CEILING_BYTES = 52428800

/** instance_config.upload_ceiling_bytes (jsonb number or string); 50 MiB when unset or unusable. */
export async function getUploadCeilingBytes(): Promise<number> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_value')
    .eq('config_key', 'upload_ceiling_bytes')
    .maybeSingle()

  if (error || data?.config_value == null) return DEFAULT_UPLOAD_CEILING_BYTES
  const value = Number(typeof data.config_value === 'string' ? data.config_value.replace(/^"|"$/g, '') : data.config_value)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_UPLOAD_CEILING_BYTES
}

/** The part a mirrored attachment becomes: only file parts carry a storage path. */
export function toMirroredPart(
  part: any,
  mirrored: { path: string; url: string; contentType: string },
): any {
  return {
    ...part,
    type: 'file',
    fileType: part.fileType ?? fileTypeOf(mirrored.contentType),
    url: mirrored.url,
    path: mirrored.path,
  }
}

const DEFAULT_INLINE_MAX_BYTES = 26214400

/** Largest file mirrored inside a request; bigger ones (or failed ones) go to the queue. */
function inlineMaxBytes(): number {
  const value = Number(process.env.BRIDGE_MIRROR_INLINE_MAX_BYTES)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_INLINE_MAX_BYTES
}

/**
 * Apply the instance-wide bridge attachment policy to a message's content parts.
 * In `mirror` mode, Discord CDN file parts are copied into the channel's room of
 * message_media and carry its path, up to the inline limit. A part that is too large for the
 * request, that the server's cap refuses, or whose mirror fails, keeps its Discord URL and sets
 * `deferred` so the caller queues the message for the background worker. Any other mode leaves
 * parts untouched. Resolved server-side so bridge bots never need to know the instance policy.
 * A caller that then does not store the message passes the parts to discardMirroredParts
 * (bridge/mirrorEnqueue.ts).
 */
export async function applyBridgeAttachmentPolicy(
  parts: any[],
  botId: string,
  channelId: string,
): Promise<{ parts: any[]; deferred: boolean }> {
  if (!Array.isArray(parts) || parts.length === 0) return { parts, deferred: false }

  const mode = await getBridgeAttachmentMode()
  if (mode !== 'mirror') return { parts, deferred: false }

  let deferred = false
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
      const mirrored = await mirrorFileToStorage(url, {
        botId,
        channelId,
        fileName: typeof part.fileName === 'string' ? part.fileName : undefined,
        contentType: typeof part.contentType === 'string' ? part.contentType : undefined,
        knownSize: typeof part.fileSize === 'number' ? part.fileSize : undefined,
        ceiling: Math.min(await getUploadCeilingBytes(), inlineMaxBytes()),
      })
      // A mirrored attachment is a file part: only file parts carry a path.
      out.push(toMirroredPart(part, mirrored))
    } catch (error: any) {
      // TooLargeError and OverQuotaError included: the worker records them, and a raised
      // ceiling or cap requeues the message.
      console.error(`Mirror deferred, keeping Discord URL: ${error?.message || error}`)
      deferred = true
      out.push(part)
    }
  }
  return { parts: out, deferred }
}

export type BridgeAttachmentMode = 'link' | 'refresh' | 'mirror'

/** instance_config.bridge_attachment_mode; `link` when unset or unknown. `failed`: the error of a read that failed. */
async function readMode(): Promise<{ mode: BridgeAttachmentMode; failed?: string }> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_value')
    .eq('config_key', 'bridge_attachment_mode')
    .maybeSingle()

  if (error) return { mode: 'link', failed: error.message }
  if (!data?.config_value) return { mode: 'link' }

  let raw = data.config_value
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { /* plain string */ }
  }
  const mode = String(raw).replace(/^"|"$/g, '')
  return { mode: mode === 'refresh' || mode === 'mirror' ? mode : 'link' }
}

/** A failed read answers `link`. */
export async function getBridgeAttachmentMode(): Promise<BridgeAttachmentMode> {
  return (await readMode()).mode
}

/** A failed read throws. */
export async function readBridgeAttachmentMode(): Promise<BridgeAttachmentMode> {
  const { mode, failed } = await readMode()
  if (failed !== undefined) throw new Error(`bridge_attachment_mode read failed: ${failed}`)
  return mode
}
