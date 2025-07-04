import { supabase } from '@/supabase'

/**
 * Normalizes avatar URL to ensure consistent display across the application
 * Handles both full URLs and path-only formats
 */
export function getAvatarUrl(avatarUrl: string | null | undefined): string {
  // Return default avatar if no URL provided
  if (!avatarUrl) {
    return '/default_avatar.png'
  }

  // If it's already a full URL (starts with http/https), return as-is
  if (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) {
    return avatarUrl
  }

  // If it's a path-only format, construct the full Supabase storage URL
  if (avatarUrl.includes('/') && !avatarUrl.startsWith('/')) {
    const { data } = supabase.storage
      .from('avatars')
      .getPublicUrl(avatarUrl)
    
    return data.publicUrl
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