import { configuredBaseUrl } from '../bridge/bridgeConfig.js'

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
