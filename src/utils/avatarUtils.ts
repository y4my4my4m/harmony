import { supabase } from '@/supabase'

/**
 * Normalizes avatar URL to ensure consistent display across the application
 * Handles both full URLs and path-only formats
 * Always returns the proper public URL for Supabase storage paths with optimization
 * 
 * @param avatarUrl - The avatar URL (can be local path, Supabase URL, or remote/federated URL)
 * @param size - Desired size for optimization (only applies to local Supabase storage)
 * @param isLocalUser - Whether this is a local user (true) or remote/federated user (false). If undefined, will try to detect.
 */
export function getAvatarUrl(avatarUrl: string | null | undefined, size: number = 256, isLocalUser?: boolean): string {
  // Return default avatar if no URL provided or if it's not a string
  if (!avatarUrl || typeof avatarUrl !== 'string') {
    return '/default_avatar.webp'
  }

  // If it's already a full URL (http/https)
  if (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) {
    // Check if this is OUR Supabase storage URL (local user)
    const pathMatch = avatarUrl.match(/\/storage\/v1\/object\/public\/avatars\/(.+)$/)
    if (pathMatch) {
      // This is a local user's Supabase storage URL - optimize it
      const avatarPath = pathMatch[1]
      const { data } = supabase.storage
        .from('avatars')
        .getPublicUrl(avatarPath, {
          transform: { width: size, height: size, resize: 'contain', quality: 80 }
        })
      return data.publicUrl
    }
    // External/remote URL (federated user) - return as-is, don't transform
    // This could be from another ActivityPub instance, Mastodon, etc.
    return avatarUrl
  }

  // If isLocalUser is explicitly false, this is a remote user with an unexpected format
  // Return as-is or default
  if (isLocalUser === false) {
    // Remote user with non-URL format - might be a path from their instance
    // Return default since we can't resolve it
    return '/default_avatar.webp'
  }

  // If it's a Supabase storage path (local user - contains user ID folder structure)
  // Only process if we know it's local OR if isLocalUser is undefined (assume local for backward compat)
  if (avatarUrl.includes('/') && !avatarUrl.startsWith('/') && (isLocalUser === true || isLocalUser === undefined)) {
    // Use public URL since avatars bucket is now public
    const { data } = supabase.storage
      .from('avatars')
      .getPublicUrl(avatarUrl, {
        transform: { width: size, height: size, resize: 'contain', quality: 80 }
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
 * Normalizes avatar URL for storage - ensures we store paths, not full URLs
 * This should be used before saving avatar URLs to the database
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
  
  // If it's an external URL, return as-is (we'll store the full URL)
  return avatarUrl
}