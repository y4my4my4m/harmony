import { supabase } from '@/supabase'

/**
 * Normalizes server URL to ensure consistent display across the application
 * Handles both full URLs and path-only formats
 * Always returns the proper public URL for Supabase storage paths
 */
export function getServerIconUrl(serverUrl: string | null | undefined): string {
  // Return default server if no URL provided or if it's not a string
  if (!serverUrl || typeof serverUrl !== 'string') {
    return '/default_server.png'
  }

  // If it's a blob URL (from file selection preview), return as-is
  if (serverUrl.startsWith('blob:')) {
    return serverUrl
  }

  // If it's already a full URL (starts with http/https), return as-is
  // This handles external URLs and already-processed Supabase URLs
  if (serverUrl.startsWith('http://') || serverUrl.startsWith('https://')) {
    return serverUrl
  }

  // If it's a Supabase storage path (contains user ID folder structure)
  if (serverUrl.includes('/') && !serverUrl.startsWith('/')) {
    const { data } = supabase.storage
      .from('server_icons')
      .getPublicUrl(serverUrl, {
        transform: { width: 96, height: 96, resize: 'contain', quality: 80 }
      })

    return data.publicUrl
  }

  // If it's a local path (starts with /), return as-is
  if (serverUrl.startsWith('/')) {
    return serverUrl
  }

  // If it's just a filename or doesn't match expected patterns, return default
  return '/default_server.png'
}

/**
 * Normalizes server URL for storage - ensures we store paths, not full URLs
 * This should be used before saving server URLs to the database
 */
export function normalizeServerForStorage(serverUrl: string | null | undefined): string | null {
  if (!serverUrl) return null
  
  // Blob URLs should never be stored - they're temporary preview URLs
  if (serverUrl.startsWith('blob:')) {
    return null
  }
  
  // If it's already a path (not a full URL), return as-is
  if (!serverUrl.startsWith('http://') && !serverUrl.startsWith('https://')) {
    return serverUrl
  }
  
  // If it's a Supabase storage URL, extract the path
  if (serverUrl.includes('/storage/v1/object/public/server-icons/')) {
    const pathMatch = serverUrl.match(/\/storage\/v1\/object\/public\/server-icons\/(.+)$/)
    if (pathMatch) {
      return pathMatch[1]
    }
  }
  
  // If it's an external URL, return as-is (we'll store the full URL)
  return serverUrl
}