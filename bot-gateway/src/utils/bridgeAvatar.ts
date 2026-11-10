import { createHash } from 'node:crypto'
import { supabase } from '../config/supabase.js'
import { publicStorageUrl } from './messageMedia.js'
import { stripMediaBytes } from './stripMetadata.js'

export const MAX_BRIDGE_AVATAR_BYTES = 1024 * 1024

/** Only raster image bytes are accepted; no URLs, SVG, HTML or storage paths. */
export function bridgeAvatarBytes(data: unknown, contentType: unknown): { bytes: Buffer; extension: string } | null {
  if (typeof data !== 'string' || data.length > 4 * Math.ceil(MAX_BRIDGE_AVATAR_BYTES / 3)) return null
  const bytes = Buffer.from(data, 'base64')
  if (!bytes.length || bytes.length > MAX_BRIDGE_AVATAR_BYTES || bytes.toString('base64') !== data) return null
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  const gif = ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
  const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  const extension = contentType === 'image/png' && png ? 'png'
    : contentType === 'image/jpeg' && jpeg ? 'jpg'
      : contentType === 'image/gif' && gif ? 'gif'
        : contentType === 'image/webp' && webp ? 'webp' : null
  return extension ? { bytes, extension } : null
}

export async function storeBridgeAvatar(botId: string, image: { bytes: Buffer; extension: string }, contentType: string): Promise<string> {
  const bytes = Buffer.from(await stripMediaBytes(image.bytes))
  const hash = createHash('sha256').update(bytes).digest('hex')
  const path = `bridges/${botId}/${hash}.${image.extension}`
  const bucket = supabase.storage.from('avatars')
  const { error } = await bucket.upload(path, bytes, { contentType, upsert: true, cacheControl: '86400' })
  if (error) throw new Error('Bridge avatar storage unavailable')
  const { data } = bucket.getPublicUrl(path)
  return publicStorageUrl(data.publicUrl)
}
