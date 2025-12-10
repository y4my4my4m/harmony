import { supabase } from '@/supabase'

// Constants
const DEFAULT_SERVER_ICON = '/default_server.webp'
const SERVER_ICONS_BUCKET = 'server_icons'
const SUPABASE_STORAGE_PATTERN = /\/storage\/v1\/object\/public\/server_icons\/(.+)$/

// Storage transformation options
const TRANSFORM_OPTIONS = {
  resize: 'contain' as const,
  quality: 80,
}

/**
 * Get the origin (protocol + host) from a URL string
 */
function getUrlOrigin(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * Check if a URL is from our Supabase instance
 */
function isOurSupabaseUrl(url: string): boolean {
  const ourSupabaseUrl = import.meta.env.VITE_SUPABASE_URL
  if (!ourSupabaseUrl) return false

  const urlOrigin = getUrlOrigin(url)
  const ourOrigin = getUrlOrigin(ourSupabaseUrl)

  return urlOrigin !== null && ourOrigin !== null && urlOrigin === ourOrigin
}

/**
 * Transform a Supabase storage path with size optimization
 */
function transformSupabaseStoragePath(path: string, size: number): string {
  const { data } = supabase.storage
    .from(SERVER_ICONS_BUCKET)
    .getPublicUrl(path, {
      transform: {
        width: size,
        height: size,
        ...TRANSFORM_OPTIONS,
      },
    })

  return data.publicUrl
}

/**
 * Normalizes server URL to ensure consistent display across the application.
 * 
 * Handles:
 * - Blob URLs (preview images)
 * - Full HTTP/HTTPS URLs (external or Supabase storage)
 * - Supabase storage paths (relative paths)
 * - Local paths (starting with /)
 * 
 * For our Supabase storage URLs, applies size optimization.
 * For external URLs (including other Supabase instances), returns as-is.
 * 
 * @param serverUrl - The server icon URL (can be null, undefined, or various formats)
 * @param size - Desired icon size in pixels (default: 96)
 * @returns Normalized URL string, or default icon path if invalid
 */
export function getServerIconUrl(serverUrl: string | null | undefined, size: number = 96): string {
  // Handle null/undefined/empty
  if (!serverUrl || typeof serverUrl !== 'string') {
    return DEFAULT_SERVER_ICON
  }

  const trimmed = serverUrl.trim()
  if (!trimmed) {
    return DEFAULT_SERVER_ICON
  }

  // Blob URLs (file preview) - return as-is
  if (trimmed.startsWith('blob:')) {
    return trimmed
  }

  // Full URLs (http/https)
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const storageMatch = trimmed.match(SUPABASE_STORAGE_PATTERN)
    
    // If it's a Supabase storage URL, check if it's ours
    if (storageMatch && isOurSupabaseUrl(trimmed)) {
      const path = storageMatch[1]
      return transformSupabaseStoragePath(path, size)
    }

    // External URL (including other Supabase instances) - return as-is
    return trimmed
  }

  // Supabase storage path (relative path like "uuid/uuid.png")
  // Must contain / but not start with / and not be a full URL
  if (trimmed.includes('/') && !trimmed.startsWith('/') && !trimmed.includes('://')) {
    return transformSupabaseStoragePath(trimmed, size)
  }

  // Local path (starts with /) - return as-is
  if (trimmed.startsWith('/')) {
    return trimmed
  }

  // Unknown format - return default
  return DEFAULT_SERVER_ICON
}

/**
 * Normalizes server URL for storage in the database.
 * 
 * Ensures we store:
 * - Relative paths for our Supabase storage (not full URLs)
 * - Full URLs for external sources (federated servers)
 * - null for blob URLs (temporary previews)
 * 
 * @param serverUrl - The server icon URL to normalize
 * @returns Normalized URL string for storage, or null if invalid
 */
export function normalizeServerForStorage(serverUrl: string | null | undefined): string | null {
  if (!serverUrl || typeof serverUrl !== 'string') {
    return null
  }

  const trimmed = serverUrl.trim()
  if (!trimmed) {
    return null
  }

  // Blob URLs are temporary - never store them
  if (trimmed.startsWith('blob:')) {
    return null
  }

  // If it's already a relative path, return as-is
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return trimmed
  }

  // If it's a Supabase storage URL from our instance, extract the path
  const storageMatch = trimmed.match(SUPABASE_STORAGE_PATTERN)
  if (storageMatch && isOurSupabaseUrl(trimmed)) {
    return storageMatch[1]
  }

  // External URL (including other Supabase instances) - store full URL
  return trimmed
}
