import { supabase } from '@/supabase'

/**
 * Normalizes avatar URL to ensure consistent display across the application
 * Handles both full URLs and path-only formats
 * Always returns the proper public URL for Supabase storage paths with optimization
 */
export function getAvatarUrl(avatarUrl: string | null | undefined, size: number = 256): string {
  // Return default avatar if no URL provided or if it's not a string
  if (!avatarUrl || typeof avatarUrl !== 'string') {
    return '/default_avatar.png'
  }

  // If it's already a full URL, check if it's a Supabase storage URL that needs transformation
  if (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) {
    // Check if this is a Supabase storage URL for avatars
    const pathMatch = avatarUrl.match(/\/storage\/v1\/object\/public\/avatars\/(.+)$/)
    if (pathMatch) {
      // Extract the path and use Supabase storage transformation
      const avatarPath = pathMatch[1]
      const { data } = supabase.storage
        .from('avatars')
        .getPublicUrl(avatarPath, {
          transform: { width: size, height: size, resize: 'contain', quality: 80 }
        })
      return data.publicUrl
    }
    // External URLs (not Supabase storage) - return as-is
    return avatarUrl
  }

  // If it's a Supabase storage path (contains user ID folder structure)
  if (avatarUrl.includes('/') && !avatarUrl.startsWith('/')) {
    // Use public URL since avatars bucket is now public
    const { data } = supabase.storage
      .from('avatars')
      .getPublicUrl(avatarUrl, {
        transform: { width: 256, height: 256, resize: 'contain', quality: 80 }
      })

    return data.publicUrl
  }

  // If it's a local path (starts with /), return as-is
  if (avatarUrl.startsWith('/')) {
    return avatarUrl
  }

  // If it's just a filename or doesn't match expected patterns, return default
  return '/default_avatar.png'
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