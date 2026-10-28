import { shallowReactive } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { supabase, SUPABASE_URL } from '@/supabase'
import { debug } from '@/utils/debug'
import { getAttachmentThumbnailUrl } from '@/utils/storageImageUtils'
import { stripKlipyAttributionFragment } from '@/utils/klipyAttribution'
import type { FileContent } from '@/types'
import { driveAvailable, getDriveFileStatus } from '@/services/drive/driveService'
import { uploadStorageObject } from '@/services/uploads/storageUpload'
import type { StoredSource } from '@/services/messageMediaUpload'
import type { ByteSource } from '@/utils/stripMetadata'

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
 * re-renders the reader. A thumbnail is signed on its own: storage-api's bulk sign
 * takes no transform, and the render endpoint reads the transformation from the token.
 *
 * Signed URLs are also kept in localStorage until shortly before they expire, so a
 * reload or a restart neither signs again nor misses the browser's cache of the
 * image under its URL. Sign-out drops them.
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

/** An object uploaded in Drive itself: `u/<uploader auth uid>/<file>`. */
export function isDriveUploadPath(path: string | null | undefined): boolean {
  if (typeof path !== 'string') return false
  const segments = path.split('/')
  return segments.length === 3 && segments[0] === 'u' && UUID.test(segments[1]) && /^[^?#\\]+$/.test(segments[2])
    && segments[2] !== '.' && segments[2] !== '..'
}

/** An object name of message_media: a room object or a Drive upload. */
export function isMessageMediaPath(path: string | null | undefined): path is string {
  return mediaRoomOfPath(path) !== null || isDriveUploadPath(path)
}

export function isPrivateMediaPart(part: unknown): part is MediaPartLike & { path: string } {
  if (!part || typeof part !== 'object') return false
  const path = (part as { path?: unknown }).path
  return typeof path === 'string' && isMessageMediaPath(path)
}

/**
 * Objects the file parts of `content` name, sorted and distinct: messages.media_paths of an
 * encrypted message, whose parts the server cannot read. Besides objects of the message's
 * room these are the author's Drive files sent again. Read access of the room, cleanup and
 * Drive's "where used" follow this list while the message lives.
 */
export function messageMediaPathsIn(content: readonly unknown[], room: string | null): string[] {
  if (!room) return []
  const paths = new Set<string>()
  for (const part of content) {
    if ((part as { type?: unknown })?.type === 'file' && isPrivateMediaPart(part)) {
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

const PERSIST_KEY = 'harmony.signedMediaUrls'
/** Entries kept across reloads; about 0.5 KB each. */
const PERSIST_MAX = 2000
/** Writes coalesce for this long, ms. */
const PERSIST_DELAY_MS = 2000
let persistTimer: ReturnType<typeof setTimeout> | null = null

/** [cache key, URL, expiresAt ms] */
type PersistedEntry = [string, string, number]

function loadPersisted(): void {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PERSIST_KEY) : null
    if (!raw) return
    const now = Date.now()
    for (const [key, url, expiresAt] of JSON.parse(raw) as PersistedEntry[]) {
      if (typeof key === 'string' && typeof url === 'string' && expiresAt - now >= REFRESH_MARGIN_MS) {
        entries.set(key, { url, expiresAt })
      }
    }
  } catch {
    /* storage blocked or corrupt; signing starts empty */
  }
}

function writePersisted(): void {
  persistTimer = null
  try {
    const now = Date.now()
    const kept: PersistedEntry[] = []
    for (const [key, entry] of entries) {
      if (entry.url && entry.expiresAt - now >= REFRESH_MARGIN_MS) kept.push([key, entry.url, entry.expiresAt])
    }
    kept.sort((a, b) => b[2] - a[2])
    localStorage.setItem(PERSIST_KEY, JSON.stringify(kept.slice(0, PERSIST_MAX)))
  } catch {
    /* quota or blocked storage: the in-memory cache still serves this session */
  }
}

function schedulePersist(): void {
  if (persistTimer || typeof localStorage === 'undefined') return
  persistTimer = setTimeout(writePersisted, PERSIST_DELAY_MS)
}

/** Sign-out: forgets every signed URL, in memory and in localStorage. */
export function forgetSignedMediaUrls(): void {
  entries.clear()
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  try {
    localStorage.removeItem(PERSIST_KEY)
  } catch {
    /* blocked storage holds nothing */
  }
}
const queued: Record<MediaVariant, Set<string>> = { original: new Set(), thumbnail: new Set() }
const inflight = new Set<string>()
const waiters = new Map<string, Array<() => void>>()
let flushScheduled = false

const cacheKey = (variant: MediaVariant, path: string) => `${variant}:${path}`

loadPersisted()

/** 'trashed' is in its owner's trash: unreadable to others until restored. */
export type GoneReason = 'expired' | 'deleted' | 'removed' | 'trashed'

/** Objects storage refused to sign whose Drive file is gone, by object name. */
const gone = shallowReactive(new Map<string, GoneReason>())
const goneChecked = new Set<string>()

async function lookUpGone(paths: string[]): Promise<void> {
  const fresh = paths.filter((p) => !goneChecked.has(p))
  if (fresh.length === 0 || !(await driveAvailable())) return
  fresh.forEach((p) => goneChecked.add(p))
  try {
    for (const row of await getDriveFileStatus(fresh)) {
      if (row.state === 'gone' && row.gone_reason) gone.set(row.path, row.gone_reason)
      else if (row.state === 'trashed') gone.set(row.path, 'trashed')
    }
  } catch (error) {
    debug.warn('Drive file status lookup failed', error)
  }
}

/** Why a private part's object is no longer there, once signing it failed; else null. */
export function mediaPartGone(part: MediaPartLike | null | undefined): GoneReason | null {
  return isPrivateMediaPart(part) ? gone.get(part.path) ?? null : null
}

function effectiveVariant(path: string, variant: MediaVariant): MediaVariant {
  return variant === 'thumbnail' && STATIC_IMAGE_EXT.test(path) ? 'thumbnail' : 'original'
}

function settle(key: string, entry: CacheEntry): void {
  entries.set(key, entry)
  if (entry.url) schedulePersist()
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
      const refused: string[] = []
      for (const path of batch) {
        const row = byPath.get(path)
        if (row?.signedUrl && !row.error) {
          settle(cacheKey('original', path), { url: row.signedUrl, expiresAt })
        } else {
          settle(cacheKey('original', path), { url: null, expiresAt: Date.now() + FAILURE_RETRY_MS })
          refused.push(path)
        }
      }
      if (refused.length > 0) void lookUpGone(refused)
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

/** Object name whose local source is `url`. */
export function localMediaPathOf(url: string): string | undefined {
  for (const [path, source] of localSources) {
    if (source === url) return path
  }
  return undefined
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
  schedulePersist()
}

/** Test hook: drops every cached and queued entry. */
export function resetMediaPartSources(): void {
  forgetSignedMediaUrls()
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

/**
 * A message_media object's bytes, fetched through a signed URL when an upload starts. Reads skip
 * the HTTP cache: the attachment's <img> preview of the same URL leaves a response without CORS
 * headers there, which a CORS fetch rejects ("Failed to fetch").
 */
export function storedObjectSource(path: string, name: string, type: string, size: number): StoredSource {
  return {
    name,
    size,
    async fetch(signal) {
      const response = await fetch(await compatUrlFor(path), { signal, cache: 'no-store' })
      if (!response.ok) throw new Error(`Reading ${name} failed (HTTP ${response.status})`)
      return new File([await response.blob()], name, { type })
    },
  }
}

/**
 * A message_media object read by HTTP range through a signed URL; a server that ignores Range
 * answers the whole object, which later reads slice.
 */
export function storedObjectBytes(path: string, size: number): ByteSource {
  let url: Promise<string> | null = null
  let whole: Uint8Array | null = null
  return {
    size,
    async read(start, end) {
      if (whole) return whole.subarray(start, end)
      if (end <= start) return new Uint8Array(0)
      url ??= compatUrlFor(path)
      const response = await fetch(await url, { headers: { Range: `bytes=${start}-${end - 1}` }, cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (response.status === 206) return bytes
      whole = bytes
      return bytes.subarray(start, end)
    },
  }
}

/** Uploads `file` into `room` under the uploader's folder. */
export async function uploadMessageMedia(
  room: string,
  uploaderId: string,
  file: Blob,
  options: { fileName?: string; contentType?: string; ownProgress?: boolean } = {},
): Promise<UploadedMessageMedia> {
  if (!mediaRoomOfPath(`${room}/`)) throw new Error('Attachments need a channel or conversation')
  const path = messageMediaPath(room, uploaderId, options.fileName ?? (file as File).name)
  const { error } = await uploadStorageObject(MESSAGE_MEDIA_BUCKET, path, file, {
    upsert: false,
    label: options.fileName ?? ((file as File).name || undefined),
    ownProgress: options.ownProgress,
    ...(options.contentType ? { contentType: options.contentType } : {}),
  })
  if (error) throw error
  return { path, url: await compatUrlFor(path) }
}

/**
 * The upload as an object a message in `room` may name. An attachment uploaded before the
 * composer switched rooms is copied there on instances without Drive.
 */
export async function placeUploadInRoom(
  upload: UploadedMessageMedia,
  room: string,
): Promise<UploadedMessageMedia> {
  if (mediaRoomOfPath(upload.path) === room) return upload
  // On an instance with Drive a message names its author's Drive files wherever they were
  // uploaded; the copy is for instances before it.
  if (await driveAvailable()) return upload
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
  altText?: string
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
    const alt = file.altText?.trim() ? { altText: file.altText.trim() } : {}
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
        ...alt,
      })
    } else if (file.uploadedUrl) {
      parts.push({ type: 'file', url: file.uploadedUrl, fileType, fileName: file.name, ...alt })
    }
  }
  return parts
}
