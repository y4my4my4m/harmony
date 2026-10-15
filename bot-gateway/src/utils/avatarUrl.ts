import { configuredBaseUrl } from '../bridge/bridgeConfig.js'
import { publicStorageUrl } from './messageMedia.js'

// An image the web app serves from public/, e.g. '/default_avatar.webp', '/discord-bridge-bot.webp'.
const BUNDLED_ASSET = /^\/[A-Za-z0-9_-]+\.(?:webp|png|jpe?g|gif|svg)$/

/**
 * Absolute avatar URL for consumers outside the web app (Discord, ActivityPub). Mirrors
 * getAvatarUrl() of src/utils/avatarUtils.ts: an absolute URL passes through, a bundled web app
 * asset resolves against configuredBaseUrl() (legacy '/default_avatar.png' as the .webp on
 * disk), anything else is an `avatars` storage path rendered at 256 px under PUBLIC_URL, else
 * SUPABASE_URL. Undefined when the needed base is unset.
 */
export function absoluteAvatarUrl(avatarPath: string | null | undefined): string | undefined {
  if (!avatarPath) return undefined

  if (avatarPath.startsWith('http://') || avatarPath.startsWith('https://')) {
    return avatarPath
  }

  if (BUNDLED_ASSET.test(avatarPath)) {
    const base = configuredBaseUrl()
    if (!base) return undefined
    return `${base}${avatarPath === '/default_avatar.png' ? '/default_avatar.webp' : avatarPath}`
  }

  const publicUrl = process.env.PUBLIC_URL || process.env.SUPABASE_URL
  if (!publicUrl) {
    console.warn('PUBLIC_URL or SUPABASE_URL not set, cannot construct avatar URL')
    return undefined
  }

  const cleanPath = avatarPath.startsWith('/') ? avatarPath.slice(1) : avatarPath

  return `${publicUrl}/storage/v1/render/image/public/avatars/${cleanPath}?width=256&height=256&resize=contain&quality=80`
}

// The web app's icon for a server without one (DEFAULT_SERVER_ICON in src/utils/serverUtils.ts).
const DEFAULT_SERVER_ICON = '/default_server.webp'

/**
 * Absolute servers.icon URL for consumers outside the web app; null for a server without an
 * icon. Mirrors getServerIconUrl() of src/utils/serverUtils.ts: an absolute URL passes through
 * with SUPABASE_URL replaced by PUBLIC_URL, a bundled web app image resolves against
 * configuredBaseUrl() and the bundled default reads as no icon, anything else is a
 * `server_icons` storage path rendered at 128 px under PUBLIC_URL, else SUPABASE_URL. Null when
 * the needed base is unset.
 */
export function absoluteServerIconUrl(icon: string | null | undefined): string | null {
  const value = typeof icon === 'string' ? icon.trim() : ''
  if (!value || value === DEFAULT_SERVER_ICON) return null

  if (value.startsWith('http://') || value.startsWith('https://')) return publicStorageUrl(value)

  if (value.startsWith('/')) {
    const base = BUNDLED_ASSET.test(value) ? configuredBaseUrl() : null
    return base ? `${base}${value}` : null
  }

  const publicUrl = (process.env.PUBLIC_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '')
  if (!publicUrl) return null
  return `${publicUrl}/storage/v1/render/image/public/server_icons/${value}?width=128&height=128&resize=contain&quality=80`
}
