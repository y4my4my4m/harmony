import { supabase } from '../config/supabase.js'
import { DISCORD_CDN_TIMEOUT_MS } from './discordSoundImport.js'
import { readStickerImageInfo } from './stickerImageInfo.js'
import { stripMediaBytes } from './stripMetadata.js'

export type ProfileImageKind = 'icon' | 'banner'

export const DISCORD_IMAGE_HASH = /^(a_)?[0-9a-f]{32}$/

export const PROFILE_IMAGE_BUCKET: Record<ProfileImageKind, 'server_icons' | 'server_banners'> = {
  icon: 'server_icons',
  banner: 'server_banners',
}

export const PROFILE_IMAGE_MAX_BYTES: Record<ProfileImageKind, number> = {
  icon: 5 * 1024 * 1024,
  banner: 10 * 1024 * 1024,
}

const CDN_PATH: Record<ProfileImageKind, string> = { icon: 'icons', banner: 'banners' }
const CDN_SIZE: Record<ProfileImageKind, number> = { icon: 1024, banner: 2048 }

/** CDN URL built from ids alone; no caller-supplied URL is fetched. */
export function discordGuildImageCdnUrl(kind: ProfileImageKind, guildId: string, hash: string): string {
  const ext = hash.startsWith('a_') ? 'gif' : 'png'
  return `https://cdn.discordapp.com/${CDN_PATH[kind]}/${guildId}/${hash}.${ext}?size=${CDN_SIZE[kind]}`
}

/** The Discord image cannot become a Harmony server image; `reason` names the limit. */
export class ProfileImageError extends Error {
  kind: ProfileImageKind
  reason: 'type' | 'size'
  constructor(kind: ProfileImageKind, reason: 'type' | 'size') {
    super(`server ${kind} refused: ${reason}`)
    this.name = 'ProfileImageError'
    this.kind = kind
    this.reason = reason
  }
}

/**
 * Copies a Discord guild icon or banner into its Harmony bucket as <serverId>/<kind>-<ms>.<ext>.
 * Throws ProfileImageError for a file Harmony cannot hold and a plain Error for CDN and
 * storage failures. Metadata is stripped losslessly.
 */
export async function storeDiscordProfileImage(
  kind: ProfileImageKind,
  serverId: string,
  guildId: string,
  hash: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ path: string }> {
  const max = PROFILE_IMAGE_MAX_BYTES[kind]
  const response = await fetchImpl(discordGuildImageCdnUrl(kind, guildId, hash), {
    signal: AbortSignal.timeout(DISCORD_CDN_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Discord CDN answered ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) throw new ProfileImageError(kind, 'size')
  const downloaded = new Uint8Array(await response.arrayBuffer())
  if (downloaded.byteLength > max) throw new ProfileImageError(kind, 'size')
  const bytes = await stripMediaBytes(downloaded)

  const info = readStickerImageInfo(bytes)
  if (!info) throw new ProfileImageError(kind, 'type')
  const ext = info.format === 'png' && info.animated ? 'apng' : info.format
  const path = `${serverId}/${kind}-${Date.now()}.${ext}`
  const { error } = await supabase.storage.from(PROFILE_IMAGE_BUCKET[kind]).upload(path, Buffer.from(bytes), {
    contentType: `image/${ext}`,
    upsert: false,
    cacheControl: '31536000',
  })
  if (error) throw new Error(`storage upload failed: ${error.message}`)
  return { path }
}

/** Best-effort cleanup of a stored profile image; logs and never throws. */
export async function removeProfileImage(kind: ProfileImageKind, path: string): Promise<void> {
  try {
    const { error } = await supabase.storage.from(PROFILE_IMAGE_BUCKET[kind]).remove([path])
    if (error) console.warn(`Removing stored server ${kind} ${path} failed: ${error.message}`)
  } catch (error) {
    console.warn(`Removing stored server ${kind} ${path} failed:`, error)
  }
}

/**
 * The object path of a servers.icon / servers.banner value when it is one of this server's
 * own objects in the bucket; null for anything foreign (external URL, default asset, other
 * server's object). Mirrors storageObjectPath in the web app's storageImageUtils.
 */
export function ownProfileObjectPath(kind: ProfileImageKind, serverId: string, value: string | null): string | null {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || /^(blob|data):/.test(trimmed)) return null
  let path: string
  if (/^https?:\/\//.test(trimmed)) {
    let pathname: string
    try {
      pathname = new URL(trimmed).pathname
    } catch {
      return null
    }
    const bucket = PROFILE_IMAGE_BUCKET[kind]
    const match = pathname.match(new RegExp(`/storage/v1/(?:object|render/image)/public/${bucket}/(.+)$`))
    if (!match) return null
    path = match[1]
  } else {
    if (trimmed.startsWith('/') || trimmed.includes('://') || !trimmed.includes('/')) return null
    path = trimmed
  }
  path = path.replace(/\/+$/, '')
  if (/%[0-9A-Fa-f]{2}/.test(path)) {
    try {
      path = decodeURIComponent(path)
    } catch {
      // keep the raw path
    }
  }
  if (path.split('/').includes('..')) return null
  return path.startsWith(`${serverId}/`) ? path : null
}
