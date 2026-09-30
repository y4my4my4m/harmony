/**
 * Row shaping for the profile media tab.
 *
 * Rows come from the get_profile_media RPC: one per post, with the post's image and video
 * attachments pre-filtered server-side into `media_attachments` (attachment objects) and
 * `content_media` (file parts from the post content). One tile per post, as on X: the
 * first item is the cover, the rest open in the lightbox.
 */
import type { MediaAttachment } from '@/types'

export interface ProfileMediaRow {
  id: string
  created_at: string
  visibility: string | null
  content_warning: string | null
  is_sensitive: boolean | null
  media_attachments: unknown
  content_media: unknown
}

/** `gif` covers image/gif files and Mastodon gifv (looping video without sound). */
export type ProfileMediaKind = 'image' | 'gif' | 'video'

export interface ProfileMediaItem {
  url: string
  previewUrl: string | null
  kind: ProfileMediaKind
  /** Rendered as <video> rather than <img>: video, and gifv. */
  isVideoFile: boolean
  alt: string
  mimeType: string | null
  /** Seconds, when the source carries it (Mastodon `meta`). */
  duration: number | null
}

export interface ProfileMediaTile {
  postId: string
  createdAt: string
  visibility: string | null
  /** Blurred until revealed: the post is marked sensitive or carries a content warning. */
  sensitive: boolean
  contentWarning: string | null
  items: ProfileMediaItem[]
}

export interface ProfileMediaCursor {
  createdAt: string
  postId: string
}

export interface LightboxEntry {
  postId: string
  item: ProfileMediaItem
}

const IMAGE_EXT = /\.(jpe?g|png|webp|avif|bmp|svg)$/i
const GIF_EXT = /\.gif$/i
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)$/i

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** URL path without query or fragment, for extension checks. */
function urlPath(url: string): string {
  return url.split(/[?#]/)[0]
}

/** Dedup key: outbox imports store each attachment twice under the same URL. */
function dedupeKey(url: string): string {
  return url.split('#')[0]
}

function kindFromUrl(url: string): { kind: ProfileMediaKind; isVideoFile: boolean } | null {
  const path = urlPath(url)
  if (GIF_EXT.test(path)) return { kind: 'gif', isVideoFile: false }
  if (IMAGE_EXT.test(path)) return { kind: 'image', isVideoFile: false }
  if (VIDEO_EXT.test(path)) return { kind: 'video', isVideoFile: true }
  return null
}

function kindFromMime(mime: string | null, url: string): { kind: ProfileMediaKind; isVideoFile: boolean } | null {
  if (!mime) return null
  const m = mime.toLowerCase()
  if (m === 'image/gif') return { kind: 'gif', isVideoFile: false }
  if (m.startsWith('image/')) return { kind: GIF_EXT.test(urlPath(url)) ? 'gif' : 'image', isVideoFile: false }
  if (m.startsWith('video/')) return { kind: 'video', isVideoFile: true }
  return null
}

/**
 * One `posts.media_attachments` entry. Shapes: composer {type 'Image', url, mediaType,
 * name (file name), description (alt)}; outbox import {type 'Document', url, mediaType,
 * name (alt)}; Mastodon API {type 'image'|'video'|'gifv', url, preview_url, description,
 * meta}. `name` is never read as alt text: on composer rows it is the file name. Outbox
 * imports carry the same attachment as a content file part with altText, and the merge in
 * toProfileMediaTile takes the alt text from there.
 */
export function normalizeAttachment(raw: unknown): ProfileMediaItem | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  const url = str(a.url) ?? str(a.remote_url)
  if (!url) return null

  const type = (str(a.type) ?? '').toLowerCase()
  const mime = str(a.mediaType) ?? str(a.mime_type) ?? str(a.mimeType)

  let shape: { kind: ProfileMediaKind; isVideoFile: boolean } | null = null
  if (type === 'gifv') shape = { kind: 'gif', isVideoFile: true }
  else if (type === 'audio') return null
  else shape = kindFromMime(mime, url)
  if (!shape && type === 'image') shape = { kind: GIF_EXT.test(urlPath(url)) ? 'gif' : 'image', isVideoFile: false }
  if (!shape && type === 'video') shape = { kind: 'video', isVideoFile: true }
  if (!shape && (type === 'document' || type === 'unknown' || type === '')) shape = kindFromUrl(url)
  if (!shape) return null

  const meta = (a.meta && typeof a.meta === 'object' ? a.meta : {}) as Record<string, unknown>
  const original = (meta.original && typeof meta.original === 'object' ? meta.original : {}) as Record<string, unknown>

  return {
    url,
    previewUrl: str(a.preview_url) ?? str(a.previewUrl) ?? null,
    ...shape,
    alt: str(a.description) ?? str(a.alt) ?? str(a.altText) ?? '',
    mimeType: mime,
    duration: num(original.duration) ?? num(meta.duration) ?? num(a.duration),
  }
}

/** One content file part: {type 'file', fileType 'image'|'video', url, mimeType, altText}. */
export function normalizeContentPart(raw: unknown): ProfileMediaItem | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (p.type !== 'file') return null
  const url = str(p.url)
  if (!url) return null

  const fileType = str(p.fileType)
  const mime = str(p.mimeType) ?? str(p.mime_type)
  let shape: { kind: ProfileMediaKind; isVideoFile: boolean }
  if (fileType === 'image') {
    shape = { kind: mime?.toLowerCase() === 'image/gif' || GIF_EXT.test(urlPath(url)) ? 'gif' : 'image', isVideoFile: false }
  } else if (fileType === 'video') {
    shape = { kind: 'video', isVideoFile: true }
  } else {
    return null
  }

  return {
    url,
    previewUrl: null,
    ...shape,
    alt: str(p.altText) ?? str(p.alt) ?? str(p.description) ?? '',
    mimeType: mime,
    duration: num(p.duration),
  }
}

/** Attachments first, then content file parts; a URL seen twice keeps the first entry and the first non-empty alt text. */
export function toProfileMediaTile(row: ProfileMediaRow): ProfileMediaTile | null {
  if (!row || typeof row.id !== 'string') return null
  const attachments = Array.isArray(row.media_attachments) ? row.media_attachments : []
  const parts = Array.isArray(row.content_media) ? row.content_media : []

  const items: ProfileMediaItem[] = []
  const byKey = new Map<string, ProfileMediaItem>()
  const candidates = [
    ...attachments.map(normalizeAttachment),
    ...parts.map(normalizeContentPart),
  ]
  for (const item of candidates) {
    if (!item) continue
    const key = dedupeKey(item.url)
    const seen = byKey.get(key)
    if (seen) {
      if (!seen.alt && item.alt) seen.alt = item.alt
      if (!seen.previewUrl && item.previewUrl) seen.previewUrl = item.previewUrl
      if (seen.duration == null && item.duration != null) seen.duration = item.duration
      continue
    }
    byKey.set(key, item)
    items.push(item)
  }
  if (items.length === 0) return null

  const contentWarning = str(row.content_warning)
  return {
    postId: row.id,
    createdAt: row.created_at,
    visibility: row.visibility ?? null,
    sensitive: row.is_sensitive === true || contentWarning !== null,
    contentWarning,
    items,
  }
}

export function toProfileMediaTiles(rows: readonly ProfileMediaRow[] | null | undefined): ProfileMediaTile[] {
  const out: ProfileMediaTile[] = []
  for (const row of rows ?? []) {
    const tile = toProfileMediaTile(row)
    if (tile) out.push(tile)
  }
  return out
}

function compareNewestFirst(a: ProfileMediaTile, b: ProfileMediaTile): number {
  const ta = Date.parse(a.createdAt)
  const tb = Date.parse(b.createdAt)
  if (ta !== tb) return tb - ta
  return a.postId < b.postId ? 1 : a.postId > b.postId ? -1 : 0
}

/** Appends a page, dropping posts already present, in the RPC's (created_at, id) DESC order. */
export function mergeProfileMediaTiles(existing: readonly ProfileMediaTile[], incoming: readonly ProfileMediaTile[]): ProfileMediaTile[] {
  const known = new Set(existing.map((t) => t.postId))
  const fresh = incoming.filter((t) => !known.has(t.postId))
  if (fresh.length === 0) return existing as ProfileMediaTile[]
  return [...existing, ...fresh].sort(compareNewestFirst)
}

/**
 * Keyset cursor for the next page: the last row of the previous page, not the last tile.
 * A row whose media all failed to normalize yields no tile but still advances the cursor.
 */
export function profileMediaCursor(rows: readonly ProfileMediaRow[]): ProfileMediaCursor | null {
  const last = rows[rows.length - 1]
  return last ? { createdAt: last.created_at, postId: last.id } : null
}

/**
 * Lightbox sequence across the grid, every item of every tile in grid order. Tiles still
 * blurred are left out, so arrowing through the lightbox never reveals sensitive media.
 */
export function buildLightboxSequence(
  tiles: readonly ProfileMediaTile[],
  isHidden: (tile: ProfileMediaTile) => boolean,
): { entries: LightboxEntry[]; startByPostId: Map<string, number> } {
  const entries: LightboxEntry[] = []
  const startByPostId = new Map<string, number>()
  for (const tile of tiles) {
    if (isHidden(tile)) continue
    startByPostId.set(tile.postId, entries.length)
    for (const item of tile.items) entries.push({ postId: tile.postId, item })
  }
  return { entries, startByPostId }
}

/** MonyMediaLightbox input. */
export function toLightboxAttachment(entry: LightboxEntry, index: number): MediaAttachment {
  const { item } = entry
  return {
    id: `${entry.postId}:${index}`,
    type: item.kind === 'gif' && item.isVideoFile ? 'gifv' : item.isVideoFile ? 'video' : 'image',
    url: item.url,
    preview_url: item.previewUrl ?? undefined,
    description: item.alt || undefined,
    mime_type: item.mimeType ?? undefined,
  }
}

/** m:ss, or h:mm:ss from an hour up. */
export function formatMediaDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
