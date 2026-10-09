import { shallowReactive } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { supabase, SUPABASE_URL } from '@/supabase'
import { debug } from '@/utils/debug'
import { getAttachmentThumbnailUrl } from '@/utils/storageImageUtils'
import { stripKlipyAttributionFragment } from '@/utils/klipyAttribution'
import type { FileContent } from '@/types'

/**
 * Chat attachments in the private `message_media` bucket.
 *
 * Object names are `<room>/<uploader auth uid>/<file>`, where the room is
 * `c/<channel id>` (channel and thread messages) or `d/<conversation id>`. A file
 * part names its object in `path`; `url` holds a signed URL valid for
 * COMPAT_URL_TTL_SECONDS from upload, which clients before 1.6.6 render. Parts
 * without `path` are legacy: `url` is the public user_media URL or a remote URL.
 *
 * Viewers sign paths through storage RLS (room membership) and cache the result
 * here. Resolution is lazy: a render that reads an unresolved path queues it, one
 * createSignedUrls call per tick signs the queue, and the reactive cache
 * re-renders the reader.
 */

export const MESSAGE_MEDIA_BUCKET = 'message_media'

/** Lifetime of a URL signed for viewing. */
export const VIEW_URL_TTL_SECONDS = 6 * 60 * 60
/** Lifetime of the URL a new part carries in `url`. */
export const COMPAT_URL_TTL_SECONDS = 7 * 24 * 60 * 60
/** A cached URL this close to expiry is re-signed on the next read. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000
/** A path that failed to sign is retried after this long. */
const FAILURE_RETRY_MS = 60 * 1000
/** createSignedUrls batch size. */
const SIGN_BATCH = 100

/** imgproxy bounding box for inline thumbnails; same box as storageImageUtils. */
const THUMBNAIL_BOX = 1024
const THUMBNAIL_QUALITY = 80
const STATIC_IMAGE_EXT = /\.(jpe?g|png)$/i

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type MediaVariant = 'original' | 'thumbnail'

export interface MediaPartLike {
  url?: string
  path?: string
}

export interface UploadedMessageMedia {
  path: string
  url: string
}

/** Room prefix of a message's attachments; null without a valid room id. */
export function mediaRoom(target: {
  channelId?: string | null
  conversationId?: string | null
}): string | null {
  if (target.conversationId && UUID.test(target.conversationId)) {
    return `d/${target.conversationId.toLowerCase()}`
  }
  if (target.channelId && UUID.test(target.channelId)) {
    return `c/${target.channelId.toLowerCase()}`
  }
  return null
}

/** Room prefix (`c/<id>` or `d/<id>`) of an object name; null for anything else. */
export function mediaRoomOfPath(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null
  const [kind, room] = path.split('/')
  if ((kind !== 'c' && kind !== 'd') || !room || !UUID.test(room)) return null
  return `${kind}/${room.toLowerCase()}`
}

function fileExtension(fileName: string | undefined): string {
  const ext = (fileName || '').split('.').pop()?.toLowerCase() || ''
  return /^[a-z0-9]{1,8}$/.test(ext) && ext !== (fileName || '').toLowerCase() ? ext : 'bin'
}

/** Object name for a new upload: `<room>/<uploader>/<uuid>.<ext>`. */
export function messageMediaPath(room: string, uploaderId: string, fileName?: string): string {
  return `${room}/${uploaderId}/${uuidv4()}.${fileExtension(fileName)}`
}

export function isPrivateMediaPart(part: unknown): part is MediaPartLike & { path: string } {
  if (!part || typeof part !== 'object') return false
  const path = (part as { path?: unknown }).path
  return typeof path === 'string' && mediaRoomOfPath(path) !== null
}

/**
 * Objects of `room` the file parts of `content` name, sorted and distinct: messages.media_paths
 * of an encrypted message, whose parts the server cannot read. Message media cleanup keeps
 * these objects while the message lives and deletes them when an edit or delete drops them.
 */
export function messageMediaPathsIn(content: readonly unknown[], room: string | null): string[] {
  if (!room) return []
  const paths = new Set<string>()
  for (const part of content) {
    if ((part as { type?: unknown })?.type === 'file' && isPrivateMediaPart(part)
        && mediaRoomOfPath(part.path) === room) {
      paths.add(part.path)
    }
  }
  return [...paths].sort()
}

/** Unsigned reference to an object; resolves for nobody without a bearer token. */
export function messageMediaReferenceUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/authenticated/${MESSAGE_MEDIA_BUCKET}/${path}`
}

const STORAGE_OBJECT_URL = /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/?#]+)\/([^?#]+)/

/** Bucket and object name of a storage object, public, signed or authenticated URL. */
export function storageObjectFromUrl(url: string): { bucket: string; path: string } | null {
  const match = STORAGE_OBJECT_URL.exec(url)
  if (!match) return null
  try {
    return { bucket: decodeURIComponent(match[1]), path: decodeURIComponent(match[2]) }
  } catch {
    return null
  }
}

/** Key of a part's load state: the object name of a private part, else its URL. */
export function mediaLoadKey(part: MediaPartLike): string {
  return isPrivateMediaPart(part) ? part.path : part.url || ''
}

/** File name to show for a part: its fileName, else the last path or URL segment. */
export function mediaPartFileName(part: MediaPartLike & { fileName?: string }): string {
  if (part.fileName) return part.fileName
  const source = isPrivateMediaPart(part) ? part.path : (part.url || '').split(/[?#]/)[0]
  const last = source.split('/').pop() || ''
  try {
    return decodeURIComponent(last) || 'Unknown file'
  } catch {
    return last || 'Unknown file'
  }
}

// ---------------------------------------------------------------------------
// Signed URL cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  /** Null after a failed signing; retried once expiresAt passes. */
  url: string | null
  expiresAt: number
}

const entries = shallowReactive(new Map<string, CacheEntry>())
const queued: Record<MediaVariant, Set<string>> = { original: new Set(), thumbnail: new Set() }
const inflight = new Set<string>()
const waiters = new Map<string, Array<() => void>>()
let flushScheduled = false

const cacheKey = (variant: MediaVariant, path: string) => `${variant}:${path}`

function effectiveVariant(path: string, variant: MediaVariant): MediaVariant {
  return variant === 'thumbnail' && STATIC_IMAGE_EXT.test(path) ? 'thumbnail' : 'original'
}

function settle(key: string, entry: CacheEntry): void {
  entries.set(key, entry)
  inflight.delete(key)
  const pending = waiters.get(key)
  if (pending) {
    waiters.delete(key)
    pending.forEach((resolve) => resolve())
  }
}

function needsSigning(key: string, now: number): boolean {
  if (inflight.has(key)) return false
  const entry = entries.get(key)
  if (!entry) return true
  if (!entry.url) return entry.expiresAt <= now
  return entry.expiresAt - now < REFRESH_MARGIN_MS
}

function enqueue(variant: MediaVariant, path: string): void {
  if (!needsSigning(cacheKey(variant, path), Date.now())) return
  queued[variant].add(path)
  if (flushScheduled) return
  flushScheduled = true
  // Deferred: callers enqueue during render, which must not write reactive state.
  setTimeout(() => {
    flushScheduled = false
    void flush()
  }, 0)
}

async function signOriginals(paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += SIGN_BATCH) {
    const batch = paths.slice(i, i + SIGN_BATCH)
    const expiresAt = Date.now() + VIEW_URL_TTL_SECONDS * 1000
    try {
      const { data, error } = await supabase.storage
        .from(MESSAGE_MEDIA_BUCKET)
        .createSignedUrls(batch, VIEW_URL_TTL_SECONDS)
      if (error) throw error
      const byPath = new Map((data || []).map((row) => [row.path, row]))
      for (const path of batch) {
        const row = byPath.get(path)
        if (row?.signedUrl && !row.error) {
          settle(cacheKey('original', path), { url: row.signedUrl, expiresAt })
        } else {
          settle(cacheKey('original', path), { url: null, expiresAt: Date.now() + FAILURE_RETRY_MS })
        }
      }
    } catch (error) {
      debug.warn('Signing message media failed', error)
      for (const path of batch) {
        settle(cacheKey('original', path), { url: null, expiresAt: Date.now() + FAILURE_RETRY_MS })
      }
    }
  }
}

async function signThumbnail(path: string): Promise<void> {
  const expiresAt = Date.now() + VIEW_URL_TTL_SECONDS * 1000
  try {
    const { data, error } = await supabase.storage
      .from(MESSAGE_MEDIA_BUCKET)
      .createSignedUrl(path, VIEW_URL_TTL_SECONDS, {
        transform: { width: THUMBNAIL_BOX, height: THUMBNAIL_BOX, resize: 'contain', quality: THUMBNAIL_QUALITY },
      })
    if (error || !data?.signedUrl) throw error || new Error('no signed URL')
    settle(cacheKey('thumbnail', path), { url: data.signedUrl, expiresAt })
  } catch (error) {
    debug.warn('Signing message media thumbnail failed', error)
    settle(cacheKey('thumbnail', path), { url: null, expiresAt: Date.now() + FAILURE_RETRY_MS })
  }
}

async function flush(): Promise<void> {
  const take = (variant: MediaVariant) => {
    const paths = [...queued[variant]].filter((p) => !inflight.has(cacheKey(variant, p)))
    queued[variant].clear()
    paths.forEach((p) => inflight.add(cacheKey(variant, p)))
    return paths
  }
  const originals = take('original')
  const thumbnails = take('thumbnail')
  await Promise.all([
    originals.length ? signOriginals(originals) : Promise.resolve(),
    ...thumbnails.map(signThumbnail),
  ])
}

function cachedUrl(variant: MediaVariant, path: string): string | undefined {
  const entry = entries.get(cacheKey(variant, path))
  return entry?.url && entry.expiresAt > Date.now() ? entry.url : undefined
}

function failed(variant: MediaVariant, path: string): boolean {
  const entry = entries.get(cacheKey(variant, path))
  return !!entry && !entry.url
}

/** A part's `url` when it is a fetchable http(s) URL. */
function partHttpUrl(part: MediaPartLike): string | undefined {
  return typeof part.url === 'string' && /^https?:\/\//i.test(part.url) ? part.url : undefined
}

/**
 * Source URL of a media part for rendering: the local source of this client's
 * upload, else the remote source.
 */
export function mediaPartSource(
  part: MediaPartLike | null | undefined,
  variant: MediaVariant = 'original',
): string | undefined {
  if (isPrivateMediaPart(part)) {
    const local = localSources.get(part.path)
    if (local) return local
  }
  return remoteMediaPartSource(part, variant)
}

/**
 * Remote source URL of a media part. Reactive: reads the signed URL cache and
 * queues signing on a miss. Undefined while a private path is pending; the
 * part's own `url` after signing failed.
 */
export function remoteMediaPartSource(
  part: MediaPartLike | null | undefined,
  variant: MediaVariant = 'original',
): string | undefined {
  if (!part) return undefined
  if (!isPrivateMediaPart(part)) {
    const url = typeof part.url === 'string' ? part.url : undefined
    if (!url) return undefined
    return variant === 'thumbnail' ? getAttachmentThumbnailUrl(stripKlipyAttributionFragment(url)) : url
  }

  const path = part.path
  const v = effectiveVariant(path, variant)
  enqueue(v, path)
  const url = cachedUrl(v, path)
  if (url) return url
  if (v === 'thumbnail' && failed('thumbnail', path)) return remoteMediaPartSource(part, 'original')
  if (failed(v, path)) return partHttpUrl(part)
  return undefined
}

function signed(variant: MediaVariant, path: string): Promise<void> {
  const key = cacheKey(variant, path)
  enqueue(variant, path)
  if (!inflight.has(key) && !queued[variant].has(path)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const list = waiters.get(key) || []
    list.push(resolve)
    waiters.set(key, list)
  })
}

/**
 * Signs the private paths of `parts` and resolves once each is settled. Parts
 * with a local source render without signing and are skipped.
 */
export async function ensureMediaPartSources(
  parts: Array<MediaPartLike | null | undefined>,
  variant: MediaVariant = 'original',
): Promise<void> {
  const pending: Promise<void>[] = []
  for (const part of parts) {
    if (!isPrivateMediaPart(part) || localSources.has(part.path)) continue
    pending.push(signed(effectiveVariant(part.path, variant), part.path))
  }
  await Promise.all(pending)
}

/** Fetchable URL of a part for actions (download, copy, open); signs on demand. */
export async function resolveMediaPartUrl(
  part: MediaPartLike | null | undefined,
): Promise<string | undefined> {
  if (!part) return undefined
  if (!isPrivateMediaPart(part)) return partHttpUrl(part)
  await signed('original', part.path)
  return remoteMediaPartSource(part)
}

// ---------------------------------------------------------------------------
// Local sources
// ---------------------------------------------------------------------------

/** Object URLs of this client's uploads by object name; they render ahead of signed URLs. */
const localSources = shallowReactive(new Map<string, string>())

export function registerLocalMediaSource(path: string, url: string): void {
  localSources.set(path, url)
}

/** Drops the mapping; the caller owns and revokes the object URL. */
export function releaseLocalMediaSource(path: string): void {
  localSources.delete(path)
}

export function localMediaSource(path: string | null | undefined): string | undefined {
  return path ? localSources.get(path) : undefined
}

/** Drops every mapping; sign-out. The registrants revoke their object URLs. */
export function clearLocalMediaSources(): void {
  localSources.clear()
}

/**
 * Signs the remote image source a render of `part` would use and loads it into
 * the document's image cache. A thumbnail that fails to sign or load falls back to
 * the original. False when no remote source loaded within `timeoutMs`.
 */
export async function preloadRemoteImageSource(
  part: MediaPartLike & { path: string },
  timeoutMs = 30_000,
): Promise<boolean> {
  const load = (src: string) => new Promise<boolean>((resolve) => {
    const img = new Image()
    const timer = setTimeout(() => resolve(false), timeoutMs)
    img.onload = () => { clearTimeout(timer); resolve(true) }
    img.onerror = () => { clearTimeout(timer); resolve(false) }
    img.src = src
  })
  const variant = effectiveVariant(part.path, 'thumbnail')
  await signed(variant, part.path)
  const thumbnail = remoteMediaPartSource(part, variant)
  if (thumbnail && await load(thumbnail)) return true
  if (variant === 'original') return false
  reportMediaPartError(part, 'thumbnail')
  await signed('original', part.path)
  const original = remoteMediaPartSource(part, 'original')
  return !!original && load(original)
}

const lastErrorAt = new Map<string, number>()
/** Minimum spacing of re-signs a load error triggers for one object. */
const ERROR_RESIGN_INTERVAL_MS = 5 * 60 * 1000

/**
 * A rendered source failed to load. A thumbnail falls back to the original for the
 * view lifetime (image transformation off, or a format imgproxy refuses). An original
 * is re-signed, at most once per ERROR_RESIGN_INTERVAL_MS; an expired URL is the
 * usual cause.
 */
export function reportMediaPartError(part: MediaPartLike | null | undefined, variant: MediaVariant = 'original'): void {
  if (!isPrivateMediaPart(part)) return
  const v = effectiveVariant(part.path, variant)
  const key = cacheKey(v, part.path)
  if (v === 'thumbnail') {
    entries.set(key, { url: null, expiresAt: Date.now() + VIEW_URL_TTL_SECONDS * 1000 })
    return
  }
  const now = Date.now()
  if (now - (lastErrorAt.get(key) ?? 0) < ERROR_RESIGN_INTERVAL_MS) return
  lastErrorAt.set(key, now)
  entries.delete(key)
}

/** Records a URL signed elsewhere (the uploader's compat URL). */
export function primeMediaPartSource(path: string, url: string, ttlSeconds: number): void {
  entries.set(cacheKey('original', path), { url, expiresAt: Date.now() + ttlSeconds * 1000 })
}

/** Test hook: drops every cached and queued entry. */
export function resetMediaPartSources(): void {
  entries.clear()
  queued.original.clear()
  queued.thumbnail.clear()
  inflight.clear()
  waiters.clear()
  lastErrorAt.clear()
  localSources.clear()
  flushScheduled = false
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/**
 * Signed URL for the part's `url`, valid COMPAT_URL_TTL_SECONDS. The uploader
 * reads its own folder; on failure the part carries an unsigned reference.
 */
export async function compatUrlFor(path: string): Promise<string> {
  try {
    const { data, error } = await supabase.storage
      .from(MESSAGE_MEDIA_BUCKET)
      .createSignedUrl(path, COMPAT_URL_TTL_SECONDS)
    if (error || !data?.signedUrl) throw error || new Error('no signed URL')
    primeMediaPartSource(path, data.signedUrl, COMPAT_URL_TTL_SECONDS)
    return data.signedUrl
  } catch (error) {
    debug.warn('Signing a compat URL failed', error)
    return messageMediaReferenceUrl(path)
  }
}

/** Uploads `file` into `room` under the uploader's folder. */
export async function uploadMessageMedia(
  room: string,
  uploaderId: string,
  file: Blob,
  options: { fileName?: string; contentType?: string } = {},
): Promise<UploadedMessageMedia> {
  if (!mediaRoomOfPath(`${room}/`)) throw new Error('Attachments need a channel or conversation')
  const path = messageMediaPath(room, uploaderId, options.fileName ?? (file as File).name)
  const { error } = await supabase.storage
    .from(MESSAGE_MEDIA_BUCKET)
    .upload(path, file, { upsert: false, ...(options.contentType ? { contentType: options.contentType } : {}) })
  if (error) throw error
  return { path, url: await compatUrlFor(path) }
}

/**
 * The upload as an object of `room`. An attachment uploaded before the composer
 * switched rooms is copied there: a message part names objects of its own room.
 */
export async function placeUploadInRoom(
  upload: UploadedMessageMedia,
  room: string,
): Promise<UploadedMessageMedia> {
  if (mediaRoomOfPath(upload.path) === room) return upload
  const rest = upload.path.split('/').slice(2).join('/')
  const target = `${room}/${rest}`
  const { error } = await supabase.storage.from(MESSAGE_MEDIA_BUCKET).copy(upload.path, target)
  if (error) throw error
  return { path: target, url: await compatUrlFor(target) }
}

/** Composer attachment state (FilePreviewData) read by attachmentParts. */
export interface ComposerAttachment {
  name: string
  type: string
  size?: number
  uploadStatus?: string
  uploadedUrl?: string
  uploadedPath?: string
}

export function attachmentFileType(mimeType: string): 'image' | 'video' | 'audio' | 'file' {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  return 'file'
}

/** File parts for the completed uploads of a send into `room`. */
export async function attachmentParts(
  files: ComposerAttachment[],
  room: string | null,
): Promise<FileContent[]> {
  const parts: FileContent[] = []
  for (const file of files) {
    if (file.uploadStatus !== 'completed') continue
    const fileType = attachmentFileType(file.type || '')
    if (file.uploadedPath && file.uploadedUrl) {
      if (!room) throw new Error('Attachments need a channel or conversation')
      const placed = await placeUploadInRoom({ path: file.uploadedPath, url: file.uploadedUrl }, room)
      parts.push({
        type: 'file',
        url: placed.url,
        path: placed.path,
        fileType,
        fileName: file.name,
        ...(typeof file.size === 'number' ? { fileSize: file.size } : {}),
      })
    } else if (file.uploadedUrl) {
      parts.push({ type: 'file', url: file.uploadedUrl, fileType, fileName: file.name })
    }
  }
  return parts
}
