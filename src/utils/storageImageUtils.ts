import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

/**
 * Shared helpers for Supabase-storage-backed images.
 *
 * Single source of truth for "is this URL a local storage host" (and therefore
 * transformable via imgproxy) and for building downscaled attachment
 * thumbnails. Avatar/emoji/server-icon helpers reuse the hostname detection here
 * instead of each re-deriving it from env.
 */

/** Hostnames serving local Supabase storage. Set via VITE_SUPABASE_URL
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Stored paths arrive percent-encoded (getPublicUrl encodes again -> 400) or
// with a trailing slash (-> 400).
function cleanObjectPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  if (!/%[0-9A-Fa-f]{2}/.test(trimmed)) return trimmed
  try {
    return decodeURIComponent(trimmed)
  } catch {
    return trimmed
  }
}

/**
 * Object path inside `bucket` for a stored image reference: a bare path, or a
 * public/render URL on this instance's storage host. Null for anything else
 * (remote URLs, bundled assets, blob/data URLs, other buckets).
 */
export function storageObjectPath(bucket: string, value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || /^(blob|data):/.test(trimmed)) return null
  if (/^https?:\/\//.test(trimmed)) {
    if (!isLocalStorageUrl(trimmed)) return null
    const pattern = new RegExp(`/storage/v1/(?:object|render/image)/public/${escapeRegExp(bucket)}/(.+)$`)
    const match = new URL(trimmed).pathname.match(pattern)
    return match ? cleanObjectPath(match[1]) || null : null
  }
  if (trimmed.startsWith('/') || trimmed.includes('://') || !trimmed.includes('/')) return null
  return cleanObjectPath(trimmed)
}

/** Untransformed public URL of a stored image; remote URLs pass through. */
export function rawStorageUrl(bucket: string, value: string | null | undefined): string | null {
  const path = storageObjectPath(bucket, value)
  if (path) return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl || null
  if (!value || !/^https?:\/\//.test(value)) return null
  // Another instance's render URL 400s where transforms are off; its object URL does not.
  return value.includes('/storage/v1/render/image/public/')
    ? value.replace('/storage/v1/render/image/public/', '/storage/v1/object/public/').split('?')[0]
    : value
}

const RENDER_PUBLIC_SEGMENT = '/storage/v1/render/image/public/'
const OBJECT_PUBLIC_SEGMENT = '/storage/v1/object/public/'
const TRANSFORM_PARAMS = ['width', 'height', 'resize', 'quality', 'format']

/**
 * Object URL behind a public render URL: same host and object, transform
 * parameters dropped, other query parameters kept. Null for any other URL,
 * including signed render URLs, whose token does not cover the object route.
 */
export function renderToObjectUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const at = parsed.pathname.indexOf(RENDER_PUBLIC_SEGMENT)
  if (at < 0) return null
  parsed.pathname =
    parsed.pathname.slice(0, at) + OBJECT_PUBLIC_SEGMENT + parsed.pathname.slice(at + RENDER_PUBLIC_SEGMENT.length)
  for (const param of TRANSFORM_PARAMS) parsed.searchParams.delete(param)
  return parsed.toString()
}

const UNRENDERED_EXT = /\.apng$/i
const UNRENDERED_MIME = 'image/apng'

/**
 * Whether a stored image loads untransformed: APNG, by the final extension of
 * the object path (or URL path) or by `mimeType` when known. imgproxy v3.8
 * renders APNG as its first frame. GIF renders keep every frame and, as WebP,
 * are usually smaller than the source. A `.webp` name is rendered: 1.6.5
 * wrote static WebP; animated WebP refused by imgproxy is covered by
 * renderFallback.
 */
export function skipsRender(pathOrUrl: string | null | undefined, mimeType?: string | null): boolean {
  if (mimeType?.toLowerCase() === UNRENDERED_MIME) return true
  if (!pathOrUrl) return false
  return UNRENDERED_EXT.test(pathOrUrl.split(/[?#]/)[0])
}

export interface ImageTransform {
  width: number
  height: number
  resize: 'cover' | 'contain' | 'fill'
  quality: number
}

/** Public URL of `path` in `bucket`: rendered with `transform`, or the object URL where skipsRender holds. */
export function publicImageUrl(bucket: string, path: string, transform: ImageTransform): string {
  const options = skipsRender(path) ? undefined : { transform }
  return supabase.storage.from(bucket).getPublicUrl(path, options).data.publicUrl
}

/**
 * Best-effort removal of the object a new upload replaced. Only objects under
 * `folder/` other than `current` are removed.
 */
export async function removeReplacedObject(
  bucket: string,
  previous: string | null | undefined,
  current: string,
  folder: string,
): Promise<void> {
  const path = storageObjectPath(bucket, previous)
  if (!path || !path.startsWith(`${folder}/`) || path === storageObjectPath(bucket, current)) return
  const { error } = await supabase.storage.from(bucket).remove([path])
  if (error) debug.warn(`Could not remove replaced ${bucket} object`, path, error)
}

/**
 * Inline attachment thumbnails.
 *
 * Message/DM/thread galleries would otherwise render the raw upload, so a 12MB
 * photo is downloaded in full to fill a ~400px mosaic cell. Local uploads are
 * downscaled through imgproxy for the inline view; the lightbox still opens
 * the raw URL at full size.
 *
 * Only local `user_media` uploads are transformed. Remote URLs (Discord CDN,
 * federated/misskey, pasted links) can't be transformed and pass through.
 * Only .jpg/.jpeg/.png names are transformed, and not a PNG whose `mimeType`
 * is APNG (skipsRender).
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
  mimeType?: string | null,
): string {
  if (!url || typeof url !== 'string') return ''
  if (!url.startsWith('http://') && !url.startsWith('https://')) return url
  if (!STATIC_IMAGE_EXT.test(url) || skipsRender(url, mimeType)) return url
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
