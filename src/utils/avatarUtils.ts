import { supabase } from '@/supabase'
import { canonicalSquareSize } from '@/utils/imageTransformUtils'

/**
 * Normalizes an avatar URL. Accepts full URLs and path-only forms; Supabase
 * storage paths come back as transformed public URLs.
 */
// Storage paths arrive in inconsistent shapes: already percent-encoded
// (getPublicUrl double-encodes them -> 400) or with a trailing slash (-> 400).
function cleanStoragePath(path: string): string {
  let p = path.replace(/\/+$/, '')
  if (/%[0-9A-Fa-f]{2}/.test(p)) {
    try { p = decodeURIComponent(p) } catch { /* keep original */ }
  }
  return p
}

export function getAvatarUrl(avatarUrl: string | null | undefined, size: number = 256): string {
  const renderSize = canonicalSquareSize(size)
  if (!avatarUrl || typeof avatarUrl !== 'string') {
    return '/default_avatar.webp'
  }

  // Legacy DB rows still have '/default_avatar.png' as their DEFAULT value;
  // the asset is .webp on disk. Normalize to avoid a 404 per old profile/bot.
  if (avatarUrl === '/default_avatar.png') {
    return '/default_avatar.webp'
  }

  // If it's already a full URL, check if it's a Supabase storage URL
  if (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) {
    let urlObj: URL
    try {
      urlObj = new URL(avatarUrl)
    } catch {
      return '/default_avatar.webp'
    }
    const localSupabaseUrl = import.meta.env.VITE_SUPABASE_URL || ''
    const localSupabaseHost = localSupabaseUrl ? new URL(localSupabaseUrl).hostname : ''
    const isRemote = !!localSupabaseHost && urlObj.hostname !== localSupabaseHost

    // Remote render/image URLs 400 when that instance has transforms disabled;
    // the raw object URL always works.
    if (isRemote && urlObj.pathname.includes('/storage/v1/render/image/public/')) {
      urlObj.pathname = urlObj.pathname
        .replace('/storage/v1/render/image/public/', '/storage/v1/object/public/')
        .replace(/\/+$/, '')
      urlObj.search = ''
      return urlObj.toString()
    }

    const pathMatch = urlObj.pathname.match(/\/storage\/v1\/object\/public\/avatars\/(.+?)\/*$/)
    if (pathMatch) {
      if (isRemote) {
        return avatarUrl
      }
      // Local Supabase URL - extract path and use local storage transformation
      const { data } = supabase.storage
        .from('avatars')
        .getPublicUrl(cleanStoragePath(pathMatch[1]), {
          transform: { width: renderSize, height: renderSize, resize: 'contain', quality: 80 }
        })
      return data.publicUrl
    }
    // External URLs (not Supabase storage) - return as-is
    return avatarUrl
  }

  // If it's a Supabase storage path (contains user ID folder structure)
  if (avatarUrl.includes('/') && !avatarUrl.startsWith('/')) {
    const { data } = supabase.storage
      .from('avatars')
      .getPublicUrl(cleanStoragePath(avatarUrl), {
        transform: { width: renderSize, height: renderSize, resize: 'contain', quality: 80 }
      })

    return data.publicUrl
  }

  // If it's a local path (starts with /), return as-is
  if (avatarUrl.startsWith('/')) {
    return avatarUrl
  }

  // If it's just a filename or doesn't match expected patterns, return default
  return '/default_avatar.webp'
}

/**
 * Normalizes an avatar URL for storage: paths, not full URLs.
 * Applied before writing an avatar URL to the database.
 */
export function normalizeAvatarForStorage(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl) return null
  
  // If it's already a path (not a full URL), return as-is
  if (!avatarUrl.startsWith('http://') && !avatarUrl.startsWith('https://')) {
    return avatarUrl
  }
  
  // If it's a Supabase storage URL, extract the path
  if (avatarUrl.includes('/storage/v1/object/public/avatars/')) {
    const pathMatch = avatarUrl.match(/\/storage\/v1\/object\/public\/avatars\/(.+)$/)
    if (pathMatch) {
      return pathMatch[1]
    }
  }
  
  // External URL: stored as-is, full URL
  return avatarUrl
}