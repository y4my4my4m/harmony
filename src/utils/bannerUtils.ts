import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { uploadImageObject } from '@/utils/fileUpload'
import { bannerRenderSize } from '@/utils/imageTransformUtils'
import { rawStorageUrl, storageObjectPath } from '@/utils/storageImageUtils'

const BANNERS_BUCKET = 'banners'

/**
 * Display URL for a profile banner shown in a cssWidth×cssHeight box.
 *
 * Banners in this instance's storage come back as render URLs sized to the
 * box at the current devicePixelRatio, snapped to shared variants. Remote
 * URLs pass through. Pair with getRawBannerUrl as the fallback where
 * transforms are disabled.
 */
export function getBannerUrl(bannerUrl?: string | null, options?: { width?: number; height?: number; quality?: number }): string | null {
  if (!bannerUrl) return null
  const path = storageObjectPath(BANNERS_BUCKET, bannerUrl)
  if (!path) return bannerUrl.startsWith('http') ? bannerUrl : null
  return getPublicBannerUrl(path, options)
}

/** Render URL for a banner object path; see getBannerUrl. */
export function getPublicBannerUrl(storagePath: string, options?: { width?: number; height?: number; quality?: number }): string | null {
  try {
    const { width, height } = bannerRenderSize(options?.width ?? 640, options?.height ?? 200)
    const { data } = supabase.storage
      .from(BANNERS_BUCKET)
      .getPublicUrl(storagePath, {
        transform: { width, height, resize: 'cover', quality: options?.quality ?? 80 },
      })
    return data.publicUrl || null
  } catch (error) {
    debug.error('Error getting public banner URL:', error)
    return null
  }
}

/** Stored banner object, untransformed; remote URLs pass through. */
export function getRawBannerUrl(bannerUrl?: string | null): string | null {
  return rawStorageUrl(BANNERS_BUCKET, bannerUrl)
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
 * Uploads a profile banner under a new `<userId>/banner-<ms>.<ext>` name.
 * `url` is the object path.
 */
export async function uploadBanner(file: File, userId: string): Promise<{ success: boolean; url?: string; error?: string }> {
  if (!file || file.size === 0) {
    return { success: false, error: 'Choose a non-empty image file' }
  }
  const result = await uploadImageObject(file, 'profile_banner', BANNERS_BUCKET, userId, 'banner')
  return result.success && result.path
    ? { success: true, url: result.path }
    : { success: false, error: result.error }
}

/**
 * Delete banner from storage
 */
export async function deleteBanner(storagePath: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.storage
      .from(BANNERS_BUCKET)
      .remove([storagePath])

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
