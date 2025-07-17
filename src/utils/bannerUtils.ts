import { supabase } from '@/supabase'

/**
 * Get banner URL for a user
 * Returns a public URL for banner stored in Supabase storage, or fallback to external URL
 */
export function getBannerUrl(bannerUrl?: string | null, options?: { width?: number; height?: number; quality?: number }): string | null {
  if (!bannerUrl) return null
  
  // If it's already a full URL (external), return as-is
  if (bannerUrl.startsWith('http')) {
    return bannerUrl
  }
  
  // If it's a storage path, get the public URL with optional optimization
  return getPublicBannerUrl(bannerUrl, options)
}

/**
 * Get public banner URL from storage path with optional Supabase transform optimization
 */
export function getPublicBannerUrl(storagePath: string, options?: { width?: number; height?: number; quality?: number }): string | null {
  try {
    const { data } = supabase.storage
      .from('banners')
      .getPublicUrl(storagePath, {
        transform: options ? {
          width: options.width || 1280,
          height: options.height || 720,
          resize: 'cover',
          quality: options.quality || 80
        } : undefined
      })

    if (!data.publicUrl) {
      console.error('Error getting public banner URL: No public URL returned')
      return null
    }

    return data.publicUrl
  } catch (error) {
    console.error('Error getting public banner URL:', error)
    return null
  }
}

/**
 * Normalize banner URL for storage
 * Converts signed URLs back to storage paths for database storage
 */
export function normalizeBannerForStorage(bannerUrl?: string | null): string | null {
  if (!bannerUrl) return null
  
  // If it's a signed URL from our storage, extract the path
  if (bannerUrl.includes('/storage/v1/object/sign/banners/')) {
    const pathMatch = bannerUrl.match(/\/storage\/v1\/object\/sign\/banners\/([^?]+)/)
    if (pathMatch) {
      return pathMatch[1]
    }
  }
  
  // If it's a direct storage path, return as-is
  if (!bannerUrl.startsWith('http')) {
    return bannerUrl
  }
  
  // External URL, return as-is
  return bannerUrl
}

/**
 * Upload banner file to storage
 */
export async function uploadBanner(file: File, userId: string): Promise<{ success: boolean; url?: string; error?: string }> {
  try {
    const ext = file.name.split('.').pop()
    if (!ext) {
      return { success: false, error: 'File must have an extension' }
    }
    
    const filePath = `${userId}/${userId}_banner.${ext}`
    
    const { error } = await supabase.storage
      .from('banners')
      .upload(filePath, file, { upsert: true })

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true, url: filePath }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

/**
 * Delete banner from storage
 */
export async function deleteBanner(storagePath: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.storage
      .from('banners')
      .remove([storagePath])

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
