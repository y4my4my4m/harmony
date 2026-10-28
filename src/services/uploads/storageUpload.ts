import { reactive } from 'vue'
import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from '@/supabase'
import { i18n } from '@/i18n'
import { humanizeUploadError } from '@/utils/uploadValidation'
import { registerTransfer, settleTransfer, type TransferEntry, type TransferProgress } from '@/services/transfers'
import { immutableUploadOptions, type PreparedImage } from '@/utils/imageResize'
import { checkUploadLimit, limitRefusal } from '@/services/uploads/uploadLimit'

/**
 * Every storage upload of the app: progress, abort, the transfers indicator, and resumable
 * transfer of large files.
 *
 * Up to TUS_THRESHOLD_BYTES a file goes up in one request, as @supabase/storage-js 2.84
 * StorageFileApi.uploadOrUpdate sends a Blob: POST /storage/v1/object/<bucket>/<path>, multipart
 * body with `cacheControl`, `metadata` (JSON, stored as user_metadata) and the file under an empty
 * field name, `x-upsert`, and the session's access token (the anon key without a session) as
 * bearer, as supabase-js fetchWithAuth. Over XMLHttpRequest: fetch reports no upload progress.
 *
 * Above it the file goes to storage-api's TUS endpoint (/storage/v1/upload/resumable; tus 1.0.0
 * core, creation and termination) in PATCHes ending on TUS_CHUNK_BYTES boundaries. A PATCH that
 * fails on the network, stalls, or meets a 5xx, 423, 429 or an offset conflict (409) is resumed
 * from the offset a HEAD reports, after TUS_RETRY_DELAYS_MS; while the browser is offline the
 * wait lasts until it is back. A HEAD with no usable Upload-Offset, or one showing a short part
 * stored (unevenPart), terminates the upload and starts a new one. The empty PATCH that only
 * completes an upload, answered 5xx, does the same once; the second time the upload fails. A
 * creation answered 404 or 405, or whose Location the page may not read
 * (Access-Control-Expose-Headers), sends this and every later file in one request; one with no
 * answer at all while the browser is online, this file only.
 *
 * Deviation from tus-js-client: the PATCH and HEAD URL is SUPABASE_URL plus the upload id, the
 * last segment of the creation Location. storage-api builds Location from forwarded headers;
 * behind nginx and Kong it can carry Kong's port or lack the /storage/v1 prefix.
 *
 * A file over the account's upload limit (uploadLimit.ts) in message_media or user_media fails
 * before its first byte with UploadLimitError, listed in the transfers indicator like any failed
 * upload. A refusal from storage of a file over the limit as read again fails the same way.
 *
 * An upload given a `resumeKey` records its TUS upload in localStorage until it settles. The same
 * file uploaded again under the same key, after a reload within RESUME_TTL_MS, continues that
 * upload and its object, whatever `path` the new call names. A record whose upload this page is
 * still sending is not continued: the second upload gets its own.
 */

export type UploadStatus = 'uploading' | 'completed' | 'error' | 'aborted'

export interface UploadState {
  /** Fraction of the file sent, 0 to 1. */
  progress: number
  loaded: number
  total: number
  status: UploadStatus
  error: string | null
  /** A dropped connection is being retried (TUS). */
  reconnecting: boolean
  transport: 'multipart' | 'tus' | null
  /** Cancels what the upload belongs to; set by its owner. */
  cancel?: () => void
}

export interface StorageUploadOptions {
  bucket: string
  path: string
  file: Blob
  /** Stored content type; the file's own type otherwise. */
  contentType?: string
  /** Seconds, as storage-js cacheControl. */
  cacheControl?: string
  upsert?: boolean
  /** user_metadata of the object. */
  metadata?: Record<string, unknown>
  /** Name in the transfers indicator; without one the upload is not listed. */
  label?: string
  /** The starting page shows this upload's progress: the indicator lists it only on other pages. */
  ownProgress?: boolean
  onProgress?: (fraction: number) => void
  /** Scope within which an interrupted upload of the same file is continued. */
  resumeKey?: string
  /** State to write instead of a new one. */
  state?: UploadState
}

export interface StorageUploadResult {
  /** Object name; a continued upload names the object it continues. */
  path: string
}

export interface StorageUpload {
  readonly state: UploadState
  /** Rejects with UploadAbortedError after abort(). */
  readonly result: Promise<StorageUploadResult>
  abort(): void
}

export class UploadAbortedError extends Error {
  constructor() {
    super('Upload aborted')
    this.name = 'UploadAbortedError'
  }
}

/**
 * A refusal from storage. `message` is user-facing; `detail` is storage's own message and
 * `statusCode` its body's statusCode (storage-api answers RLS refusals 400 with "403"), as
 * storage-js StorageApiError carries them; `status` is the HTTP status.
 */
export class StorageUploadError extends Error {
  readonly statusCode: string
  constructor(message: string, readonly status: number, readonly detail = '', statusCode?: string | number) {
    super(message)
    this.name = 'StorageUploadError'
    this.statusCode = String(statusCode ?? status)
  }
}

/** storage-js DEFAULT_FILE_OPTIONS.cacheControl. */
export const DEFAULT_CACHE_CONTROL = '3600'

/**
 * Files above this size take the resumable endpoint: Supabase's recommendation for TUS, and
 * well under the 50 MB request bodies nginx and Caddy admit and Cloudflare's 100 MB.
 */
export const TUS_THRESHOLD_BYTES = 6 * 1024 * 1024

/**
 * PATCH size. Supabase requires 6 MiB chunks on its S3 backend: storage-api's S3Store (@tus/s3-store
 * 2.0) stores each PATCH of at least TUS_MIN_PART_BYTES as one multipart part, and R2 refuses to
 * complete an upload whose parts other than the last differ in size. Chunks end on multiples of
 * this size.
 *
 * A PATCH cut short keeps the bytes storage received (@tus/server ends the stream on a
 * disconnect). Under TUS_MIN_PART_BYTES past the chunk boundary they are held as an incomplete
 * part, which the resumed PATCH prepends: the part ends on the boundary at full size. At or above
 * it they are stored as a short part, and the upload restarts (unevenPart).
 */
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024

/** @tus/s3-store minPartSize, 5_242_880 bytes. */
export const TUS_MIN_PART_BYTES = 5 * 1024 * 1024

/** Waits before each resume of a failed PATCH, ms; the upload fails after the last. */
export const TUS_RETRY_DELAYS_MS = [1000, 3000, 5000, 10_000, 20_000, 30_000, 60_000]

/**
 * A request with no progress event for this long fails, ms. Idle time, not total time: a large
 * file on a slow link keeps reporting progress. After the body is sent the same limit applies to
 * the response.
 */
export const UPLOAD_STALL_MS = 60_000

/** storage-api TUS_URL_EXPIRY_MS default is an hour; a record this old is dropped unread. */
export const RESUME_TTL_MS = 55 * 60 * 1000

const TUS_VERSION = '1.0.0'
const TUS_ENDPOINT = '/storage/v1/upload/resumable'
const RESUME_STORE = 'harmony.resumableUploads'

/** The endpoint answered as absent or unreadable; this session sends every file in one request. */
let tusUnavailable = false

/** TUS upload ids being sent by this page. */
const inFlight = new Set<string>()

export function newUploadState(total: number): UploadState {
  return reactive<UploadState>({
    progress: 0,
    loaded: 0,
    total,
    status: 'uploading',
    error: null,
    reconnecting: false,
    transport: null,
  })
}

async function accessToken(): Promise<string> {
  try {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? SUPABASE_ANON_KEY
  } catch {
    return SUPABASE_ANON_KEY
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** The request ended without a response: network error, or no progress for UPLOAD_STALL_MS. */
class NetworkFailure extends Error {
  constructor(readonly stalled: boolean) {
    super(stalled ? 'stalled' : 'network error')
  }
}

/** The creation request cannot be used; `lasting` holds for the session. */
class TusUnavailableError extends Error {
  constructor(readonly lasting: boolean) {
    super('resumable uploads unavailable')
  }
}

/** Bytes of the file sent; `fraction` when it is not loaded / size. */
type Report = (loaded: number, fraction?: number) => void

interface Answer {
  status: number
  text: string
  header(name: string): string | null
}

interface Link {
  aborted: boolean
  xhr: XMLHttpRequest | null
  wake: (() => void) | null
}

function send(
  link: Link,
  method: string,
  url: string,
  headers: Record<string, string>,
  body: XMLHttpRequestBodyInit | null,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Answer> {
  if (link.aborted) return Promise.reject(new UploadAbortedError())
  return new Promise<Answer>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    link.xhr = xhr
    let stalled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const clear = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const arm = () => {
      clear()
      timer = setTimeout(() => {
        stalled = true
        xhr.abort()
      }, UPLOAD_STALL_MS)
    }
    const done = () => {
      clear()
      if (link.xhr === xhr) link.xhr = null
    }
    xhr.open(method, url)
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
    xhr.upload.onprogress = (event) => {
      arm()
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded, event.total)
    }
    xhr.upload.onload = arm
    xhr.onload = () => {
      done()
      resolve({
        status: xhr.status,
        text: xhr.responseText || '',
        header: (name) => (typeof xhr.getResponseHeader === 'function' ? xhr.getResponseHeader(name) : null),
      })
    }
    xhr.onerror = () => {
      done()
      reject(new NetworkFailure(false))
    }
    xhr.onabort = () => {
      done()
      reject(stalled ? new NetworkFailure(true) : new UploadAbortedError())
    }
    xhr.send(body)
    arm()
  })
}

function refusal(answer: Answer, bucket: string): StorageUploadError {
  let body: { message?: string; error?: string; statusCode?: string | number } = {}
  try {
    body = JSON.parse(answer.text || '{}')
  } catch {
    /* tus answers in plain text; a gateway in HTML */
    body = { message: answer.text.trim().split('\n')[0] }
  }
  const detail = body.message || body.error || ''
  const statusCode = body.statusCode ?? answer.status
  const message = humanizeUploadError({ message: detail, statusCode }, bucket)
  return new StorageUploadError(message, answer.status, detail, statusCode)
}

function networkError(failure: NetworkFailure, bucket: string): Error {
  return failure.stalled
    ? new Error(i18n.global.t('message.upload.stalled', { seconds: UPLOAD_STALL_MS / 1000 }) as string)
    : new Error(humanizeUploadError({ message: 'Network error' }, bucket))
}

function sleep(link: Link, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (link.aborted) {
      reject(new UploadAbortedError())
      return
    }
    const online = () => {
      if (navigator.onLine === false) return
      finish()
    }
    const finish = () => {
      clearTimeout(timer)
      window.removeEventListener('online', online)
      link.wake = null
      if (link.aborted) reject(new UploadAbortedError())
      else resolve()
    }
    const timer = setTimeout(() => {
      // Offline: the wait lasts until the browser is back.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return
      finish()
    }, ms)
    window.addEventListener('online', online)
    link.wake = finish
  })
}

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

async function sendWhole(
  link: Link,
  options: StorageUploadOptions,
  path: string,
  report: Report,
): Promise<void> {
  const token = await accessToken()
  const body = new FormData()
  body.append('cacheControl', options.cacheControl ?? DEFAULT_CACHE_CONTROL)
  if (options.metadata && Object.keys(options.metadata).length > 0) {
    body.append('metadata', JSON.stringify(options.metadata))
  }
  const file = options.contentType && options.file.type !== options.contentType
    ? retyped(options.file, options.contentType)
    : options.file
  body.append('', file)
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  let answer: Answer
  try {
    answer = await send(
      link,
      'POST',
      `${SUPABASE_URL}/storage/v1/object/${options.bucket}/${encodedPath}`,
      { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, 'x-upsert': options.upsert ? 'true' : 'false' },
      body,
      // The body carries the form fields too: the file's share follows the body's.
      (loaded, total) => report(options.file.size * Math.min(1, loaded / total), Math.min(1, loaded / total)),
    )
  } catch (error) {
    if (error instanceof NetworkFailure) throw networkError(error, options.bucket)
    throw error
  }
  if (answer.status < 200 || answer.status >= 300) throw refusal(answer, options.bucket)
}

/** The blob with another type; a File keeps its name. */
function retyped(file: Blob, type: string): Blob {
  const blob = file.slice(0, file.size, type)
  return file instanceof File ? new File([blob], file.name, { type, lastModified: file.lastModified }) : blob
}

// ---------------------------------------------------------------------------
// TUS
// ---------------------------------------------------------------------------

interface ResumeRecord {
  id: string
  bucket: string
  path: string
  size: number
  at: number
}

function readRecords(): Record<string, ResumeRecord> {
  try {
    const raw = localStorage.getItem(RESUME_STORE)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeRecords(records: Record<string, ResumeRecord>): void {
  try {
    const now = Date.now()
    const kept = Object.fromEntries(Object.entries(records).filter(([, r]) => now - r.at < RESUME_TTL_MS))
    if (Object.keys(kept).length === 0) localStorage.removeItem(RESUME_STORE)
    else localStorage.setItem(RESUME_STORE, JSON.stringify(kept))
  } catch {
    /* blocked storage: uploads resume within the page only */
  }
}

function fingerprint(options: StorageUploadOptions): string | null {
  if (!options.resumeKey) return null
  const file = options.file as File
  return [
    options.resumeKey,
    options.bucket,
    file.name ?? '',
    file.size,
    file.lastModified ?? '',
    options.contentType ?? file.type ?? '',
    JSON.stringify(options.metadata ?? {}),
  ].join('|')
}

/** Test hook: the stored TUS uploads. */
export function storedResumableUploads(): Record<string, { id: string; path: string }> {
  return readRecords()
}

/** Sign-out: forgets every stored TUS upload. */
export function forgetResumableUploads(): void {
  try {
    localStorage.removeItem(RESUME_STORE)
  } catch {
    /* nothing stored */
  }
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function tusUrl(id: string): string {
  return `${SUPABASE_URL}${TUS_ENDPOINT}/${id}`
}

async function tusHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await accessToken()
  return { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, 'Tus-Resumable': TUS_VERSION, ...extra }
}

/** Upload id of a creation Location: its last path segment, base64url. */
export function tusUploadId(location: string | null): string | null {
  if (!location) return null
  const last = location.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop() || ''
  return /^[A-Za-z0-9_-]+$/.test(last) ? last : null
}

async function tusCreate(link: Link, options: StorageUploadOptions, path: string): Promise<string> {
  const metadata: Array<[string, string]> = [
    ['bucketName', options.bucket],
    ['objectName', path],
    ['contentType', options.contentType || options.file.type || 'application/octet-stream'],
    ['cacheControl', options.cacheControl ?? DEFAULT_CACHE_CONTROL],
  ]
  if (options.metadata && Object.keys(options.metadata).length > 0) {
    metadata.push(['metadata', JSON.stringify(options.metadata)])
  }
  let answer: Answer
  try {
    answer = await send(link, 'POST', `${SUPABASE_URL}${TUS_ENDPOINT}`, await tusHeaders({
      'Upload-Length': String(options.file.size),
      'Upload-Metadata': metadata.map(([key, value]) => `${key} ${base64Utf8(value)}`).join(','),
      'x-upsert': options.upsert ? 'true' : 'false',
    }), null)
  } catch (error) {
    // No answer to the creation itself: a proxy or CORS refusing the endpoint, or the network.
    if (error instanceof NetworkFailure && !error.stalled && navigator.onLine !== false) {
      throw new TusUnavailableError(false)
    }
    if (error instanceof NetworkFailure) throw networkError(error, options.bucket)
    throw error
  }
  if (answer.status === 404 || answer.status === 405) throw new TusUnavailableError(true)
  if (answer.status !== 201) throw refusal(answer, options.bucket)
  const id = tusUploadId(answer.header('Location'))
  // Location not exposed to the page (Access-Control-Expose-Headers): unusable here.
  if (!id) throw new TusUnavailableError(true)
  return id
}

/**
 * HEAD of an upload: its offset; 'gone' when storage no longer has it; 'unknown' when its
 * Upload-Offset is absent or malformed, or it or Upload-Length does not fit the file.
 */
type Probe = number | 'gone' | 'unknown'

async function tusOffset(link: Link, id: string, size: number): Promise<Probe> {
  const answer = await send(link, 'HEAD', tusUrl(id), await tusHeaders(), null)
  if (answer.status === 404 || answer.status === 410 || answer.status === 403) return 'gone'
  if (answer.status < 200 || answer.status >= 300) throw new NetworkFailure(false)
  // Number(null) and Number('') are 0: an absent header is not an offset.
  const header = answer.header('Upload-Offset')?.trim() ?? ''
  const offset = /^\d+$/.test(header) ? Number(header) : NaN
  const length = answer.header('Upload-Length')
  if (!Number.isSafeInteger(offset) || offset > size) return 'unknown'
  if (length !== null && Number(length) !== size) return 'unknown'
  return offset
}

/**
 * Storage holds a short part that is not the last: at least TUS_MIN_PART_BYTES past a chunk
 * boundary, short of the end (TUS_CHUNK_BYTES). R2 refuses to complete such an upload.
 */
export function unevenPart(offset: number, size: number): boolean {
  return offset < size && offset % TUS_CHUNK_BYTES >= TUS_MIN_PART_BYTES
}

/** Termination: storage drops the upload and the parts kept so far. */
function terminate(id: string): void {
  void tusHeaders().then((headers) => fetch(tusUrl(id), { method: 'DELETE', headers })).catch(() => {})
}

/** tus answers an Upload-Offset that is not the upload's own with 409 "Upload-Offset conflict". */
function offsetConflict(error: StorageUploadError): boolean {
  return error.status === 409 && /offset/i.test(error.detail)
}

/** True when a failed PATCH is worth resuming. */
function retryable(error: unknown): boolean {
  if (error instanceof NetworkFailure) return true
  if (!(error instanceof StorageUploadError)) return false
  return error.status >= 500 || error.status === 423 || error.status === 429 || offsetConflict(error)
}

/**
 * Sends the bytes from `offset` to the next TUS_CHUNK_BYTES boundary; at the full length, an
 * empty PATCH, which runs storage's completion. Returns the new offset.
 */
async function tusPatch(
  link: Link,
  options: StorageUploadOptions,
  id: string,
  offset: number,
  report: Report,
): Promise<number> {
  const size = options.file.size
  const end = Math.min(size, (Math.floor(offset / TUS_CHUNK_BYTES) + 1) * TUS_CHUNK_BYTES)
  const answer = await send(link, 'PATCH', tusUrl(id), await tusHeaders({
    'Upload-Offset': String(offset),
    'Content-Type': 'application/offset+octet-stream',
    'x-upsert': options.upsert ? 'true' : 'false',
  }), options.file.slice(offset, end), (loaded) => report(offset + Math.min(loaded, end - offset)))
  if (answer.status === 204 || answer.status === 200) {
    const next = Number(answer.header('Upload-Offset'))
    // An offset that did not move is resynchronised by the 409 of the next PATCH.
    return Number.isFinite(next) && next > offset && next <= size ? next : end
  }
  const refused = refusal(answer, options.bucket)
  // Completion already ran for a PATCH whose answer was lost: the object exists.
  if (offset === size && refused.status === 409 && !offsetConflict(refused)) return size
  throw refused
}

async function sendResumable(
  link: Link,
  options: StorageUploadOptions,
  state: UploadState,
  report: Report,
): Promise<string> {
  const size = options.file.size
  const key = fingerprint(options)
  let path = options.path
  let id: string | null = null
  let offset = 0

  const remember = (uploadId: string) => {
    if (!key) return
    const records = readRecords()
    records[key] = { id: uploadId, bucket: options.bucket, path, size, at: Date.now() }
    writeRecords(records)
  }
  const forget = (uploadId: string) => {
    if (!key) return
    const records = readRecords()
    if (records[key]?.id === uploadId) {
      delete records[key]
      writeRecords(records)
    }
  }
  const drop = (uploadId: string) => {
    terminate(uploadId)
    forget(uploadId)
    inFlight.delete(uploadId)
  }
  const create = async () => {
    const created = await tusCreate(link, options, path)
    inFlight.add(created)
    remember(created)
    return created
  }

  if (key) {
    const record = readRecords()[key]
    // A record whose upload is in flight belongs to that upload; this one starts its own.
    if (record && !inFlight.has(record.id)) {
      let stored: Probe = 'gone'
      if (Date.now() - record.at < RESUME_TTL_MS && record.bucket === options.bucket && record.size === size) {
        inFlight.add(record.id)
        stored = await tusOffset(link, record.id, size).catch(() => 'gone' as const)
      }
      if (typeof stored === 'number' && !unevenPart(stored, size)) {
        id = record.id
        path = record.path
        offset = stored
        report(offset)
      } else {
        inFlight.delete(record.id)
        if (stored !== 'gone') terminate(record.id)
        forget(record.id)
      }
    }
  }

  // The PATCH reaching the full length runs storage's completion. Offset at the full length
  // without its answer (a resumed upload, a lost response) proves only the bytes: an empty
  // PATCH there completes it.
  let attempt = 0
  let restarted = false
  try {
    if (id === null) id = await create()
    for (;;) {
      const at = offset
      try {
        if (id === null) {
          id = await create()
          offset = 0
          report(0)
          continue
        }
        offset = await tusPatch(link, options, id, offset, report)
        attempt = 0
        state.reconnecting = false
        report(offset)
        if (offset >= size && (at < offset || at === size)) break
      } catch (thrown) {
        // A creation mid-upload that gets no usable answer is retried as a dropped request.
        const error = thrown instanceof TusUnavailableError ? new NetworkFailure(false) : thrown
        // Every byte is stored and completion alone is refused (R2: parts of unequal size): the
        // upload starts over once, then fails.
        if (id !== null && at === size && error instanceof StorageUploadError && error.status >= 500) {
          drop(id)
          id = null
          if (restarted) throw error
          restarted = true
          continue
        }
        if (!retryable(error) || attempt >= TUS_RETRY_DELAYS_MS.length) {
          if (error instanceof NetworkFailure) throw networkError(error, options.bucket)
          throw error
        }
        state.reconnecting = true
        await sleep(link, TUS_RETRY_DELAYS_MS[attempt++])
        if (id === null) continue
        const probe = await tusOffset(link, id, size).catch((failure: unknown) => {
          if (failure instanceof UploadAbortedError) throw failure
          return undefined
        })
        if (probe === 'gone') throw new StorageUploadError(humanizeUploadError({ message: 'Upload expired' }, options.bucket), 410)
        if (probe === 'unknown' || (probe !== undefined && unevenPart(probe, size))) {
          drop(id)
          id = null
          offset = 0
        } else if (probe !== undefined) {
          offset = probe
        }
        report(offset)
      }
    }
  } catch (error) {
    if (id !== null && error instanceof UploadAbortedError) {
      terminate(id)
      forget(id)
    } else if (id !== null && error instanceof StorageUploadError) {
      forget(id)
    }
    // A network failure keeps the record: the same file picked again continues the upload.
    throw error
  } finally {
    if (id !== null) inFlight.delete(id)
  }
  if (id !== null) forget(id)
  return path
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Uploads `file` as object `path` of `bucket`. */
export function startStorageUpload(options: StorageUploadOptions): StorageUpload {
  const state = options.state ?? newUploadState(options.file.size)
  state.total = options.file.size
  const link: Link = { aborted: false, xhr: null, wake: null }

  const report: Report = (loaded, fraction) => {
    const size = options.file.size
    state.loaded = Math.min(size, Math.round(loaded))
    state.progress = Math.min(1, fraction ?? (size > 0 ? loaded / size : 0))
    options.onProgress?.(state.progress)
  }

  let entry: TransferEntry | null = null
  if (options.label) {
    const view: TransferProgress = {
      get loaded() { return state.loaded },
      get total() { return state.total },
      get status() { return state.status === 'uploading' ? 'running' : state.status },
      get error() { return state.error },
      get reconnecting() { return state.reconnecting },
    }
    entry = registerTransfer({
      id: `upload:${options.bucket}/${options.path}:${Math.random().toString(36).slice(2)}`,
      direction: 'upload',
      name: options.label,
      progress: view,
      cancel: () => (state.cancel ? state.cancel() : upload.abort()),
      origin: options.ownProgress && typeof window !== 'undefined' ? window.location.pathname : undefined,
    })
  }

  const send = async (): Promise<string> => {
    if (options.file.size > TUS_THRESHOLD_BYTES && !tusUnavailable) {
      state.transport = 'tus'
      try {
        return await sendResumable(link, options, state, report)
      } catch (error) {
        if (!(error instanceof TusUnavailableError)) throw error
        if (error.lasting) tusUnavailable = true
      }
    }
    state.transport = 'multipart'
    await sendWhole(link, options, options.path, report)
    return options.path
  }

  const transfer = async (): Promise<string> => {
    await checkUploadLimit(options.bucket, options.file, options.label)
    try {
      return await send()
    } catch (error) {
      if (error instanceof StorageUploadError && error.status < 500) {
        const limited = await limitRefusal(options.bucket, options.file, options.label)
        if (limited) throw limited
      }
      throw error
    }
  }

  const result = transfer().then(
    (path) => {
      report(options.file.size)
      state.progress = 1
      state.status = 'completed'
      state.reconnecting = false
      if (entry) settleTransfer(entry)
      return { path }
    },
    (error: unknown) => {
      state.reconnecting = false
      if (link.aborted || error instanceof UploadAbortedError) {
        state.status = 'aborted'
        if (entry) settleTransfer(entry)
        throw new UploadAbortedError()
      }
      state.status = 'error'
      state.error = error instanceof Error ? error.message : 'Upload failed'
      if (entry) settleTransfer(entry)
      throw error
    },
  )
  // Callers that drop the handle leave no unhandled rejection behind.
  result.catch(() => {})

  const upload: StorageUpload = {
    state,
    result,
    abort() {
      if (link.aborted || state.status === 'completed') return
      link.aborted = true
      link.xhr?.abort()
      link.wake?.()
    },
  }
  return upload
}

/** An upload refused before its first byte, listed as a failed transfer under `name`. */
export function listRefusedUpload(name: string | undefined, size: number, message: string): void {
  if (!name) return
  const entry = registerTransfer({
    id: `upload:refused:${Math.random().toString(36).slice(2)}`,
    direction: 'upload',
    name,
    progress: { loaded: 0, total: size, status: 'error', error: message, reconnecting: false },
  })
  settleTransfer(entry)
}

export type StorageErrorLike = Error & { statusCode?: string; status?: number }

/**
 * startStorageUpload awaited, answered as supabase-js storage `upload` answers: the stored path,
 * or an error with storage's own message and statusCode, which humanizeUploadError reads.
 */
export async function uploadStorageObject(
  bucket: string,
  path: string,
  file: Blob,
  options: Omit<StorageUploadOptions, 'bucket' | 'path' | 'file'> = {},
): Promise<{ data: { path: string } | null; error: StorageErrorLike | null }> {
  try {
    const { path: stored } = await startStorageUpload({ ...options, bucket, path, file }).result
    return { data: { path: stored }, error: null }
  } catch (error) {
    if (error instanceof StorageUploadError) {
      return {
        data: null,
        error: Object.assign(new Error(error.detail || error.message), { statusCode: error.statusCode, status: error.status }),
      }
    }
    return { data: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

export interface PublicImageUploadOptions {
  /** Name in the transfers indicator; the prepared file's name by default. */
  label?: string
  /** Fraction of the image sent, 0 to 1. */
  onProgress?: (fraction: number) => void
}

/** A prepared image written under a fresh name in a public bucket; returns its public URL. */
export async function storePublicImage(
  bucket: string,
  path: string,
  prepared: PreparedImage,
  options: PublicImageUploadOptions = {},
): Promise<string> {
  const { error } = await uploadStorageObject(bucket, path, prepared.file, {
    ...immutableUploadOptions(prepared),
    label: options.label ?? prepared.file.name,
    onProgress: options.onProgress,
  })
  if (error) throw error
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl
}

/** Test hook: the TUS endpoint is tried again and no upload is in flight. */
export function resetStorageUploads(): void {
  tusUnavailable = false
  inFlight.clear()
}
