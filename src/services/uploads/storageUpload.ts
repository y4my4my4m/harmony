import { reactive } from 'vue'
import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from '@/supabase'
import { i18n } from '@/i18n'
import { humanizeUploadError } from '@/utils/uploadValidation'
import { registerTransfer, settleTransfer, type TransferEntry, type TransferProgress } from '@/services/transfers'

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
 * wait lasts until it is back. A creation answered 404 or 405, or whose Location the page may not
 * read (Access-Control-Expose-Headers), sends this and every later file in one request; one with
 * no answer at all while the browser is online, this file only.
 *
 * Deviation from tus-js-client: the PATCH and HEAD URL is SUPABASE_URL plus the upload id, the
 * last segment of the creation Location. storage-api builds Location from forwarded headers;
 * behind nginx and Kong it can carry Kong's port or lack the /storage/v1 prefix.
 *
 * An upload given a `resumeKey` records its TUS upload in localStorage until it settles. The same
 * file uploaded again under the same key, after a reload within RESUME_TTL_MS, continues that
 * upload and its object, whatever `path` the new call names.
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
 * PATCH size. Supabase requires 6 MiB chunks on its S3 backend: storage-api's S3Store sends each
 * PATCH of at least 5 MiB as one multipart part, and R2 refuses parts of unequal size. Chunks end
 * on multiples of this size, so a PATCH resumed mid-chunk completes the part it left.
 */
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024

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

/** Offset of an upload; null when storage no longer has it. */
async function tusOffset(link: Link, id: string, size: number): Promise<number | null> {
  const answer = await send(link, 'HEAD', tusUrl(id), await tusHeaders(), null)
  if (answer.status === 404 || answer.status === 410 || answer.status === 403) return null
  if (answer.status < 200 || answer.status >= 300) throw new NetworkFailure(false)
  const offset = Number(answer.header('Upload-Offset'))
  const length = answer.header('Upload-Length')
  if (!Number.isFinite(offset) || offset < 0 || offset > size) return null
  if (length !== null && Number(length) !== size) return null
  return offset
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
  const key = fingerprint(options)
  let path = options.path
  let id: string | null = null
  let offset = 0

  if (key) {
    const record = readRecords()[key]
    if (record && Date.now() - record.at < RESUME_TTL_MS && record.bucket === options.bucket && record.size === options.file.size) {
      const stored = await tusOffset(link, record.id, options.file.size).catch(() => null)
      if (stored !== null) {
        id = record.id
        path = record.path
        offset = stored
        report(offset)
      }
    }
    if (id === null && record) {
      const records = readRecords()
      delete records[key]
      writeRecords(records)
    }
  }

  if (id === null) {
    id = await tusCreate(link, options, path)
    if (key) {
      const records = readRecords()
      records[key] = { id, bucket: options.bucket, path, size: options.file.size, at: Date.now() }
      writeRecords(records)
    }
  }
  const uploadId = id
  const forget = () => {
    if (!key) return
    const records = readRecords()
    if (records[key]?.id === uploadId) {
      delete records[key]
      writeRecords(records)
    }
  }

  // The PATCH reaching the full length runs storage's completion. Offset at the full length
  // without its answer (a resumed upload, a lost response) proves only the bytes: an empty
  // PATCH there completes it.
  let attempt = 0
  let finished = false
  try {
    while (!finished) {
      try {
        const at = offset
        offset = await tusPatch(link, options, uploadId, offset, report)
        attempt = 0
        state.reconnecting = false
        report(offset)
        if (offset >= options.file.size && (at < offset || at === options.file.size)) finished = true
      } catch (error) {
        if (!retryable(error) || attempt >= TUS_RETRY_DELAYS_MS.length) {
          if (error instanceof NetworkFailure) throw networkError(error, options.bucket)
          throw error
        }
        state.reconnecting = true
        await sleep(link, TUS_RETRY_DELAYS_MS[attempt++])
        const resumed = await tusOffset(link, uploadId, options.file.size).catch((failure: unknown) => {
          if (failure instanceof UploadAbortedError) throw failure
          return undefined
        })
        if (resumed === null) throw new StorageUploadError(humanizeUploadError({ message: 'Upload expired' }, options.bucket), 410)
        if (resumed !== undefined) offset = resumed
        report(offset)
      }
    }
  } catch (error) {
    if (error instanceof UploadAbortedError) {
      // Termination: storage drops the parts kept so far.
      void tusHeaders().then((headers) => fetch(tusUrl(uploadId), { method: 'DELETE', headers })).catch(() => {})
      forget()
    } else if (error instanceof StorageUploadError) {
      forget()
    }
    // A network failure keeps the record: the same file picked again continues the upload.
    throw error
  }
  forget()
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
    })
  }

  const transfer = async (): Promise<string> => {
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

/** Test hook: the TUS endpoint is tried again. */
export function resetStorageUploads(): void {
  tusUnavailable = false
}
