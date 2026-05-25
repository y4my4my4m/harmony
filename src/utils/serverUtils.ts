import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

// Constants
const DEFAULT_SERVER_ICON = '/default_server.webp'
const SERVER_ICONS_BUCKET = 'server_icons'
const SERVER_BANNERS_BUCKET = 'server_banners'
const SUPABASE_STORAGE_PATTERN = /\/storage\/v1\/object\/public\/server_icons\/(.+)$/
const SUPABASE_BANNER_STORAGE_PATTERN = /\/storage\/v1\/object\/public\/server_banners\/(.+)$/

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
 * Get the public URL for a server banner stored in Supabase storage.
 */
export function getServerBannerUrl(
  bannerPath: string | null | undefined,
  options?: { width?: number; height?: number; quality?: number }
): string | null {
  if (!bannerPath || typeof bannerPath !== 'string') return null

  const trimmed = bannerPath.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('blob:')) return trimmed

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const storageMatch = trimmed.match(SUPABASE_BANNER_STORAGE_PATTERN)
    if (storageMatch && isOurSupabaseUrl(trimmed)) {
      return transformServerBannerPath(storageMatch[1], options)
    }
    return trimmed
  }

  if (trimmed.includes('/') && !trimmed.startsWith('/') && !trimmed.includes('://')) {
    return transformServerBannerPath(trimmed, options)
  }

  if (trimmed.startsWith('/')) return trimmed

  return null
}

function transformServerBannerPath(
  path: string,
  options?: { width?: number; height?: number; quality?: number }
): string {
  const { data } = supabase.storage
    .from(SERVER_BANNERS_BUCKET)
    .getPublicUrl(path, {
      transform: {
        width: options?.width || 1280,
        height: options?.height || 400,
        resize: 'cover' as const,
        quality: options?.quality || 80,
      },
    })
  return data.publicUrl
}

function rawServerBannerPath(path: string): string {
  const { data } = supabase.storage
    .from(SERVER_BANNERS_BUCKET)
    .getPublicUrl(path)
  return data.publicUrl
}

/**
 * Get the raw (non-transformed) public URL for a server banner.
 * Use as a fallback when imgproxy/image transforms are unavailable.
 */
export function getRawServerBannerUrl(
  bannerPath: string | null | undefined
): string | null {
  if (!bannerPath || typeof bannerPath !== 'string') return null

  const trimmed = bannerPath.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('blob:')) return trimmed

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const storageMatch = trimmed.match(SUPABASE_BANNER_STORAGE_PATTERN)
    if (storageMatch && isOurSupabaseUrl(trimmed)) {
      return rawServerBannerPath(storageMatch[1])
    }
    return trimmed
  }

  if (trimmed.includes('/') && !trimmed.startsWith('/') && !trimmed.includes('://')) {
    return rawServerBannerPath(trimmed)
  }

  if (trimmed.startsWith('/')) return trimmed

  return null
}

/**
 * Upload a server banner to Supabase storage.
 */
export async function uploadServerBanner(
  file: File,
  serverId: string
): Promise<{ success: boolean; url?: string; error?: string }> {
  try {
    const ext = file.name.split('.').pop()
    if (!ext) return { success: false, error: 'File must have an extension' }

    const filePath = `${serverId}/${serverId}_banner.${ext}`

    const { error } = await supabase.storage
      .from(SERVER_BANNERS_BUCKET)
      .upload(filePath, file, { upsert: true })

    if (error) {
      debug.error('Failed to upload server banner:', error)
      return { success: false, error: error.message }
    }

    return { success: true, url: filePath }
  } catch (error) {
    debug.error('Error uploading server banner:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

/**
 * Delete a server banner from Supabase storage.
 */
export async function deleteServerBanner(storagePath: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.storage
      .from(SERVER_BANNERS_BUCKET)
      .remove([storagePath])

    if (error) return { success: false, error: error.message }
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

/**
 * Normalize a server banner URL for storage (extract path from full URLs).
 */
export function normalizeServerBannerForStorage(bannerUrl: string | null | undefined): string | null {
  if (!bannerUrl) return null
  const trimmed = bannerUrl.trim()
  if (!trimmed || trimmed.startsWith('blob:')) return null

  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return trimmed

  const storageMatch = trimmed.match(SUPABASE_BANNER_STORAGE_PATTERN)
  if (storageMatch && isOurSupabaseUrl(trimmed)) return storageMatch[1]

  return trimmed
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
