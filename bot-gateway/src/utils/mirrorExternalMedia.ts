import { randomUUID } from 'crypto'
import { supabase } from '../config/supabase.js'

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
    (p) => p?.type === 'file' && typeof p.url === 'string' && isAllowedSourceUrl(p.url),
  )
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

function publicMediaUrl(storagePath: string): string {
  const publicBase = (process.env.PUBLIC_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '')
  return `${publicBase}/storage/v1/object/public/user_media/${storagePath}`
}

export async function mirrorExternalMediaToStorage(
  sourceUrl: string,
  opts: { botId: string; fileName?: string; contentType?: string },
): Promise<string> {
  if (!isAllowedSourceUrl(sourceUrl)) {
    throw new Error(`Refusing to mirror disallowed URL host`)
  }

  const response = await fetch(sourceUrl)
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`)
  }

  const contentType = opts.contentType || response.headers.get('content-type') || 'application/octet-stream'
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(`Attachment too large (${buffer.byteLength} bytes)`)
  }

  const storagePath = `bridge/${opts.botId}/${randomUUID()}.${extensionFrom(opts.fileName, contentType, sourceUrl)}`
  const { error } = await supabase.storage.from('user_media').upload(storagePath, buffer, {
    contentType,
    upsert: false,
    cacheControl: '31536000',
  })
  if (error) throw new Error(`Storage upload failed: ${error.message}`)

  return publicMediaUrl(storagePath)
}

/**
 * Apply the instance-wide bridge attachment policy to a message's content parts.
 * In `mirror` mode, Discord CDN file parts are copied into `user_media` and their
 * URLs rewritten to the permanent public URL. Any other mode (or a mirror failure)
 * leaves the original URL untouched. Resolved server-side so bridge bots never need
 * to know the instance policy.
 */
export async function applyBridgeAttachmentPolicy(
  parts: any[],
  botId: string,
): Promise<any[]> {
  if (!Array.isArray(parts) || parts.length === 0) return parts

  const mode = await getBridgeAttachmentMode()
  if (mode !== 'mirror') return parts

  const out: any[] = []
  for (const part of parts) {
    const url = part?.url
    if (part?.type !== 'file' || typeof url !== 'string' || !isAllowedSourceUrl(url)) {
      out.push(part)
      continue
    }
    try {
      const mirroredUrl = await mirrorExternalMediaToStorage(url, {
        botId,
        fileName: typeof part.fileName === 'string' ? part.fileName : undefined,
        contentType: typeof part.contentType === 'string' ? part.contentType : undefined,
      })
      out.push({ ...part, url: mirroredUrl })
    } catch (error: any) {
      console.error(`⚠️ Mirror failed, keeping Discord URL: ${error?.message || error}`)
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
