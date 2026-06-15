import { supabase } from '@/supabase'

/**
 * Shared helpers for Supabase-storage-backed images.
 *
 * Single source of truth for "is this URL one of our own storage hosts" (so it
 * can be transformed via imgproxy) and for building downscaled attachment
 * thumbnails. Avatar/emoji/server-icon helpers reuse the hostname detection here
 * instead of each re-deriving it from env.
 */

/** Hostnames that serve our local Supabase storage. Set via VITE_SUPABASE_URL
 *  plus optional comma-separated VITE_STORAGE_DOMAIN. */
function computeLocalStorageHostnames(): Set<string> {
  const out = new Set<string>()
  try {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
    if (supabaseUrl) out.add(new URL(supabaseUrl).hostname)
    const storageDomain = import.meta.env.VITE_STORAGE_DOMAIN as string | undefined
    if (storageDomain) {
      storageDomain
        .split(',')
        .map((h: string) => h.trim())
        .filter(Boolean)
        .forEach((h: string) => out.add(h))
    }
  } catch {
    /* ignore invalid env URLs */
  }
  return out
}

const LOCAL_STORAGE_HOSTNAMES = computeLocalStorageHostnames()

export function isLocalStorageHostname(hostname: string): boolean {
  return LOCAL_STORAGE_HOSTNAMES.has(hostname)
}

export function isLocalStorageUrl(url: string): boolean {
  try {
    return isLocalStorageHostname(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * Inline attachment thumbnails.
 *
 * Message/DM/thread galleries would otherwise render the raw upload, so a 12MB
 * photo is downloaded in full just to fill a ~400px mosaic cell. We downscale
 * local uploads through imgproxy for the inline view; the lightbox still opens
 * the raw URL at full size.
 *
 * Only our own `user_media` uploads are transformed. Remote URLs (Discord CDN,
 * federated/misskey, pasted links) can't be transformed and pass through.
 * Animated formats are left raw too — imgproxy would flatten them to one frame.
 */
const USER_MEDIA_PATTERN = /\/storage\/v1\/object\/public\/user_media\/(.+)$/
const STATIC_IMAGE_EXT = /\.(jpe?g|png)(\?|$)/i

/** Bounding box for inline thumbnails: crisp at retina (gallery caps ~400px CSS),
 *  tiny vs full uploads. */
const THUMBNAIL_BOX = 1024
const THUMBNAIL_QUALITY = 80

export function getAttachmentThumbnailUrl(
  url: string | null | undefined,
  box: number = THUMBNAIL_BOX,
): string {
  if (!url || typeof url !== 'string') return ''
  if (!url.startsWith('http://') && !url.startsWith('https://')) return url
  if (!STATIC_IMAGE_EXT.test(url)) return url
  if (!isLocalStorageUrl(url)) return url

  const pathMatch = url.match(USER_MEDIA_PATTERN)
  if (!pathMatch) return url

  const { data } = supabase.storage
    .from('user_media')
    .getPublicUrl(pathMatch[1], {
      transform: {
        width: box,
        height: box,
        resize: 'contain',
        quality: THUMBNAIL_QUALITY,
      },
    })
  return data.publicUrl
}
