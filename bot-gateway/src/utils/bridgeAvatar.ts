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

/** A native avatar is fetched only from our configured storage, never its caller-supplied URL. */
export async function nativeBridgeAvatar(avatar: string): Promise<{ data: string; content_type: string } | null> {
  let path = avatar.replace(/^\//, '')
  if (/^https?:\/\//i.test(avatar)) {
    let url: URL
    try { url = new URL(avatar) } catch { return null }
    const bases = [process.env.PUBLIC_URL, process.env.SUPABASE_URL].filter(Boolean)
    const base = bases.find(value => {
      const own = new URL(value!)
      return url.origin === own.origin && url.pathname.startsWith(`${own.pathname.replace(/\/$/, '')}/storage/v1/`)
    })
    if (!base || url.username || url.password) return null
    const prefix = new URL(base).pathname.replace(/\/$/, '') + '/storage/v1/'
    const match = /^(?:object|render\/image)\/public\/avatars\/(.+)$/.exec(url.pathname.slice(prefix.length))
    if (!match) return null
    try { path = decodeURIComponent(match[1]) } catch { return null }
  } else if (/^\/[A-Za-z0-9_-]+\.(?:webp|png|jpe?g|gif|svg)$/.test(avatar)) return null
  if (!/^[A-Za-z0-9_./-]{1,1024}$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) return null
  const { data } = supabase.storage.from('avatars').getPublicUrl(path)
  const response = await fetch(data.publicUrl, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!response.ok || !response.body) return null
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BRIDGE_AVATAR_BYTES) return null
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel() }
  const encoded = Buffer.concat(chunks).toString('base64')
  for (const content_type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    const image = bridgeAvatarBytes(encoded, content_type)
    if (image) return { data: Buffer.from(await stripMediaBytes(image.bytes)).toString('base64'), content_type }
  }
  return null
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
