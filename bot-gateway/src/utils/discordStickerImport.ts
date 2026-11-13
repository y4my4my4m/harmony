import { randomUUID } from 'node:crypto'
import { supabase } from '../config/supabase.js'
import { DISCORD_CDN_TIMEOUT_MS } from './discordSoundImport.js'
import {
  STICKER_MAX_BYTES,
  STICKER_MAX_DURATION_MS,
  STICKER_MAX_SIDE,
  readStickerImageInfo,
} from './stickerImageInfo.js'
import { stripMediaBytes } from './stripMetadata.js'

export const STICKER_BUCKET = 'stickers'
export const DISCORD_STICKER_ID = /^[0-9]{1,20}$/

/** Discord sticker format_type: 1 PNG, 2 APNG, 3 Lottie, 4 GIF. */
const FORMAT_LOTTIE = 3
const FORMAT_GIF = 4

/** CDN URL built from the id alone; no caller-supplied URL is fetched. */
export function discordStickerCdnUrl(id: string, formatType: number): string {
  return `https://media.discordapp.net/stickers/${id}.${formatType === FORMAT_GIF ? 'gif' : 'png'}?size=${STICKER_MAX_SIDE}`
}

export type StickerFileReason = 'lottie' | 'type' | 'size' | 'dimensions' | 'duration'

/** The Discord sticker cannot become a Harmony sticker; `reason` names the limit. */
export class StickerFileError extends Error {
  reason: StickerFileReason
  constructor(reason: StickerFileReason) {
    super(`sticker file refused: ${reason}`)
    this.name = 'StickerFileError'
    this.reason = reason
  }
}

/**
 * Copies a Discord sticker into the stickers bucket under server/<serverId>/<uuid>.<ext> and
 * answers the facts bridge_import_server_sticker needs. Throws StickerFileError for a sticker
 * Harmony cannot hold (Lottie, not an image, over a limit) and a plain Error for CDN and
 * storage failures. Metadata is stripped losslessly; APNG frame chunks are kept.
 */
export async function storeDiscordSticker(
  serverId: string,
  discordStickerId: string,
  formatType: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ path: string; url: string; width: number; height: number; durationMs: number | null }> {
  if (formatType === FORMAT_LOTTIE) throw new StickerFileError('lottie')
  const response = await fetchImpl(discordStickerCdnUrl(discordStickerId, formatType), {
    signal: AbortSignal.timeout(DISCORD_CDN_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Discord CDN answered ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > STICKER_MAX_BYTES) throw new StickerFileError('size')
  const downloaded = new Uint8Array(await response.arrayBuffer())
  if (downloaded.byteLength > STICKER_MAX_BYTES) throw new StickerFileError('size')
  const bytes = await stripMediaBytes(downloaded)

  const info = readStickerImageInfo(bytes)
  if (!info) throw new StickerFileError('type')
  if (info.width < 1 || info.height < 1 || info.width > STICKER_MAX_SIDE || info.height > STICKER_MAX_SIDE) {
    throw new StickerFileError('dimensions')
  }
  if (info.animated && (info.durationMs ?? 0) > STICKER_MAX_DURATION_MS) throw new StickerFileError('duration')

  const base = (process.env.PUBLIC_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '')
  if (!base) throw new Error('PUBLIC_URL or SUPABASE_URL is not set')

  const ext = info.format === 'png' && info.animated ? 'apng' : info.format
  const path = `server/${serverId}/${randomUUID()}.${ext}`
  const { error } = await supabase.storage.from(STICKER_BUCKET).upload(path, Buffer.from(bytes), {
    contentType: `image/${ext}`,
    upsert: false,
    cacheControl: '31536000',
  })
  if (error) throw new Error(`storage upload failed: ${error.message}`)

  return {
    path,
    url: `${base}/storage/v1/object/public/${STICKER_BUCKET}/${path}`,
    width: info.width,
    height: info.height,
    durationMs: info.animated ? info.durationMs : null,
  }
}

/** Best-effort cleanup of a stored sticker file; logs and never throws. */
export async function removeStoredSticker(path: string): Promise<void> {
  try {
    const { error } = await supabase.storage.from(STICKER_BUCKET).remove([path])
    if (error) console.warn(`Removing stored sticker ${path} failed: ${error.message}`)
  } catch (error) {
    console.warn(`Removing stored sticker ${path} failed:`, error)
  }
}
