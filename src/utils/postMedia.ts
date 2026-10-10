/**
 * Media a timeline post shows in MonyMediaGallery, where sensitive media is blurred.
 *
 * `posts.media_attachments` rows: composer {type 'Image' | 'Video' | 'Audio' | 'Document',
 * url, mediaType, name (file name), description (alt)}; federated {type as sent, url,
 * mediaType, description (alt)}; Mastodon API {type 'image' | 'video' | 'gifv' | 'audio',
 * url, description, meta}. Remote posts stored without media_attachments carry their media only
 * as content file parts {type 'file', url, fileType, mimeType, altText}; those parts are the
 * gallery when media_attachments is empty.
 */

import type { MediaAttachment } from '@/types'

const GALLERY_FILE_TYPES = new Set(['image', 'video', 'audio'])

function mimeOf(m: any): string {
  return String(m?.mediaType || m?.media_type || m?.mime_type || m?.mimeType || '').toLowerCase()
}

/** A content file part as an attachment row; null for parts the gallery does not show. */
function contentPartMedia(part: any): Record<string, unknown> | null {
  if (!part || typeof part !== 'object' || part.type !== 'file' || typeof part.url !== 'string') return null
  const mime = mimeOf(part)
  const kind = GALLERY_FILE_TYPES.has(part.fileType) ? part.fileType : mime.split('/')[0]
  if (!GALLERY_FILE_TYPES.has(kind)) return null
  return {
    type: kind,
    url: part.url,
    mediaType: mime || undefined,
    description: part.altText || part.alt || undefined,
    width: part.width,
    height: part.height,
    blurhash: part.blurhash,
    focalPoint: part.focalPoint,
  }
}

/**
 * Gallery type of a row: AP `Document` and unknown rows resolve by MIME type, then by URL.
 * A type outside MediaAttachment['type'] renders as a file.
 */
function galleryType(m: any, url: string): string {
  const declared = typeof m.type === 'string' ? m.type.toLowerCase() : 'unknown'
  if (declared !== 'document' && declared !== 'unknown') return declared
  const mime = mimeOf(m)
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/') || mime.includes('gif')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (/\.(jpe?g|png|gif|webp|avif)/i.test(url)) return 'image'
  if (/\.(mp4|webm|ogv|mov)/i.test(url)) return 'video'
  return declared
}

/** Gallery rows of a post (or a reblog snapshot). */
export function galleryMedia(source: any): MediaAttachment[] {
  const attached = source?.media_attachments ?? source?.mediaAttachments
  const rows: any[] = Array.isArray(attached) && attached.length > 0
    ? attached
    : (Array.isArray(source?.content) ? source.content : []).map(contentPartMedia).filter(Boolean)

  const media: MediaAttachment[] = []
  rows.forEach((m: any, idx: number) => {
    const url = m?.url || m?.remote_url || m?.href
    if (!url) return
    media.push({
      ...m,
      id: m.id || `m-${idx}`,
      url,
      type: galleryType(m, url) as MediaAttachment['type'],
    })
  })
  return media
}

/**
 * Content without the parts the gallery shows: media file parts, and any part whose URL
 * is a gallery URL. URLs match on their path; protocol, host and query may differ.
 */
export function withoutGalleryMedia<T>(content: T, media: MediaAttachment[]): T {
  if (!Array.isArray(content) || media.length === 0) return content

  const normalizeUrl = (url: string) => {
    const u = url.split('?')[0]
    const path = u.includes('/') ? u.replace(/^[^/]*\/\/[^/]+/, '') : u
    return path || u
  }
  const mediaUrlPaths = new Set(media.map((m) => normalizeUrl(String(m.url))))

  const isGalleryPart = (p: any): boolean => {
    const partUrl = p?.url
    if (partUrl && (mediaUrlPaths.has(normalizeUrl(partUrl)) || mediaUrlPaths.has(partUrl))) return true
    const t = String(p?.type || '').toLowerCase()
    if (t === 'file') {
      const ft = p?.fileType || p?.file_type || ''
      if (ft === 'image' || ft === 'video' || ft === 'audio') return true
      const mt = mimeOf(p)
      if (mt.startsWith('image/') || mt.startsWith('video/') || mt.includes('gif')) return true
      if (partUrl && /\.(jpe?g|png|gif|webp|avif|mp4|webm|ogv|mov)(\?|$)/i.test(partUrl)) return true
      return false
    }
    if (t === 'image' || t === 'video' || t === 'gifv') return true
    if (t === 'url' && partUrl) {
      return /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?|$)/i.test(partUrl) ||
        /\.(mp4|webm|ogg|avi|mov|wmv|flv|m4v)(\?|$)/i.test(partUrl)
    }
    return false
  }

  return content.filter((p: any) => !isGalleryPart(p)) as T
}
