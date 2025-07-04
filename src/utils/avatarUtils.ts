import { supabase } from '@/supabase'

/**
 * Normalizes avatar URL to ensure consistent display across the application
 * Handles both full URLs and path-only formats
 * Always returns the proper public URL for Supabase storage paths
 */
export function getAvatarUrl(avatarUrl: string | null | undefined): string {
  // Return default avatar if no URL provided
  if (!avatarUrl) {
    return '/default_avatar.png'
  }

  // If it's already a full URL (starts with http/https), return as-is
  // This handles external URLs and already-processed Supabase URLs
  if (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) {
    return avatarUrl
  }

  // If it's a Supabase storage path (contains user ID folder structure)
  if (avatarUrl.includes('/') && !avatarUrl.startsWith('/')) {
    const { data } = supabase.storage
      .from('avatars')
      .getPublicUrl(avatarUrl)
    
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
 * Gets the proper avatar URL for a user, with fallback to default
 */
export function getUserAvatarUrl(user: { avatar_url?: string | null } | null | undefined): string {
  return getAvatarUrl(user?.avatar_url)
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