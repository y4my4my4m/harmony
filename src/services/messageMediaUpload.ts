import { reactive, shallowReactive } from 'vue'
import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from '@/supabase'
import { i18n } from '@/i18n'
import { getBucketLimits, humanizeUploadError, validateImageUpload } from '@/utils/uploadValidation'
import {
  MESSAGE_MEDIA_BUCKET,
  compatUrlFor,
  isMessageMediaPath,
  type UploadedMessageMedia,
} from '@/services/privateMedia'
import {
  driveAvailable,
  findDriveFilesByHash,
  isDriveHashBlocked,
  sha256OfBlob,
  type DriveUploadMetadata,
} from '@/services/drive/driveService'

/**
 * Chat attachment uploads into message_media over XMLHttpRequest, for upload
 * progress and abort. The request mirrors @supabase/storage-js 2.84
 * StorageFileApi.uploadOrUpdate for a Blob body: POST
 * /storage/v1/object/<bucket>/<path>, multipart body with `cacheControl`, `metadata`
 * (JSON, stored as user_metadata) and the file under an empty field name,
 * `x-upsert: false`, and the session's access token (the anon key without a session) as
 * bearer, as supabase-js fetchWithAuth.
 *
 * On an instance with Drive the upload carries its SHA-256 and name (none for encrypted
 * rooms), and a file the account already keeps in Drive with the same SHA-256 is not sent
 * again: the result names that object (`reused`).
 *
 * Upload state is kept per object name and is reactive, so any render of a part
 * naming the object reads its progress.
 */

export type MessageMediaUploadStatus = 'uploading' | 'completed' | 'error' | 'aborted'

export interface MessageMediaUploadState {
  /** Fraction of the request body sent, 0 to 1. */
  progress: number
  status: MessageMediaUploadStatus
  error: string | null
  /** Cancels what the upload belongs to; set by its owner, absent for composer uploads. */
  cancel?: () => void
}

export interface MessageMediaUploadResult extends UploadedMessageMedia {
  /** The bytes were in Drive already; `path` names that object, not the planned one. */
  reused?: boolean
}

export interface MessageMediaUploadOptions {
  validate?: boolean
  onProgress?: (fraction: number) => void
  /** Drive name of the file; omitted for encrypted rooms. */
  name?: string
  /** Kept only until drive_ephemeral_days. */
  ephemeral?: boolean
  /** Send the existing Drive file with the same bytes instead of uploading them again. */
  reuse?: boolean
  /** Drive folder of the new file. */
  folder?: string | null
}

export interface MessageMediaUpload {
  readonly path: string
  readonly state: MessageMediaUploadState
  /** Rejects with UploadAbortedError after abort(). */
  readonly result: Promise<MessageMediaUploadResult>
  abort(): void
}

export class UploadAbortedError extends Error {
  constructor() {
    super('Upload aborted')
    this.name = 'UploadAbortedError'
  }
}

/** storage-js DEFAULT_FILE_OPTIONS.cacheControl. */
const CACHE_CONTROL = '3600'

/**
 * An upload with no progress event for this long fails, ms. Idle time, not total
 * time: a large file on a slow link keeps reporting progress. After the body is
 * sent the same limit applies to the response.
 */
export const UPLOAD_STALL_MS = 60_000

const states = shallowReactive(new Map<string, MessageMediaUploadState>())

export function messageMediaUploadState(path: string | null | undefined): MessageMediaUploadState | undefined {
  return path ? states.get(path) : undefined
}

export function forgetMessageMediaUpload(path: string | null | undefined): void {
  if (path) states.delete(path)
}

/**
 * Starts the once-per-session reads an upload makes before its bytes (bucket limits, the Drive
 * probe), so the first attachment waits on neither.
 */
export function prepareMessageMediaUploads(): void {
  void getBucketLimits(MESSAGE_MEDIA_BUCKET).catch(() => {})
  void driveAvailable()
}

/** Drops every upload state; sign-out. Running requests are aborted by their owners. */
export function resetMessageMediaUploads(): void {
  states.clear()
}

/**
 * Client-side pre-upload gate (BUGS.md H28). The bucket enforces size limits
 * server-side, but only after the whole upload. SVGs are rejected here: they can
 * embed script.
 */
export async function validateChatUpload(file: Blob): Promise<void> {
  const name = (file as File).name || ''
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(name)) {
    throw new Error('SVG uploads are not allowed (they can contain embedded scripts). Please convert to PNG or WebP.')
  }
  const asFile = file instanceof File ? file : new File([file], name || 'file', { type: file.type })
  const validationError = await validateImageUpload(asFile, MESSAGE_MEDIA_BUCKET)
  if (validationError) throw new Error(validationError)
}

async function accessToken(): Promise<string> {
  try {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? SUPABASE_ANON_KEY
  } catch {
    return SUPABASE_ANON_KEY
  }
}

function responseError(xhr: XMLHttpRequest): Error {
  let body: { message?: string; error?: string; statusCode?: string | number } = {}
  try {
    body = JSON.parse(xhr.responseText || '{}')
  } catch {
    /* gateway HTML error page */
  }
  const message = humanizeUploadError(
    { message: body.message || body.error || '', statusCode: body.statusCode ?? xhr.status },
    MESSAGE_MEDIA_BUCKET,
  )
  return Object.assign(new Error(message), { status: xhr.status })
}

/**
 * Uploads `file` as object `path` of message_media. The path names the target
 * room and the uploader's auth uid (see privateMedia.ts); storage RLS checks both.
 */
export function startMessageMediaUpload(
  path: string,
  file: Blob,
  options: MessageMediaUploadOptions = {},
): MessageMediaUpload {
  const state = reactive<MessageMediaUploadState>({ progress: 0, status: 'uploading', error: null })
  states.set(path, state)
  let xhr: XMLHttpRequest | null = null
  let aborted = false
  let stalled = false
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  const clearStall = () => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = null
  }
  const armStall = () => {
    clearStall()
    stallTimer = setTimeout(() => {
      stalled = true
      xhr?.abort()
    }, UPLOAD_STALL_MS)
  }

  const transfer = async (): Promise<string | null> => {
    if (!isMessageMediaPath(path)) throw new Error('Attachments need a channel or conversation')
    // Validation (bucket limits) and the Drive probe are independent reads, once per session each.
    const drive = driveAvailable()
    if (options.validate) await validateChatUpload(file)
    const metadata: DriveUploadMetadata = {}
    if (await drive) {
      metadata.sha256 = await sha256OfBlob(file)
      if (options.name) metadata.name = options.name
      if (options.ephemeral) metadata.ephemeral = true
      if (options.folder) metadata.folder = options.folder
      if (options.reuse !== false) {
        const existing = (await findDriveFilesByHash(metadata.sha256).catch(() => []))
          .find((f) => f.bucket === MESSAGE_MEDIA_BUCKET && f.state === 'drive' && f.size_bytes === file.size)
        if (existing) return existing.path
      }
    }
    const token = await accessToken()
    if (aborted) throw new UploadAbortedError()

    await new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest()
      xhr = request
      request.open('POST', `${SUPABASE_URL}/storage/v1/object/${MESSAGE_MEDIA_BUCKET}/${path}`)
      request.setRequestHeader('Authorization', `Bearer ${token}`)
      request.setRequestHeader('apikey', SUPABASE_ANON_KEY)
      request.setRequestHeader('x-upsert', 'false')
      request.upload.onprogress = (event) => {
        armStall()
        if (!event.lengthComputable || event.total <= 0) return
        state.progress = Math.min(1, event.loaded / event.total)
        options.onProgress?.(state.progress)
      }
      request.upload.onload = armStall
      request.onload = () => {
        clearStall()
        if (request.status >= 200 && request.status < 300) resolve()
        else if (metadata.sha256 && request.status < 500) {
          // A blocked hash surfaces as storage-api's generic row-level security refusal.
          const refused = responseError(request)
          isDriveHashBlocked(metadata.sha256).catch(() => false).then((blocked) => {
            reject(blocked ? new Error(i18n.global.t('drive.errors.blocked') as string) : refused)
          })
        } else reject(responseError(request))
      }
      request.onerror = () => {
        clearStall()
        reject(new Error(humanizeUploadError({ message: 'Network error' }, MESSAGE_MEDIA_BUCKET)))
      }
      request.onabort = () => {
        clearStall()
        reject(stalled
          ? new Error(i18n.global.t('message.upload.stalled', { seconds: UPLOAD_STALL_MS / 1000 }) as string)
          : new UploadAbortedError())
      }

      const body = new FormData()
      body.append('cacheControl', CACHE_CONTROL)
      if (Object.keys(metadata).length > 0) body.append('metadata', JSON.stringify(metadata))
      body.append('', file)
      request.send(body)
      armStall()
    })
    return null
  }

  const result = transfer().then(
    async (reusedPath) => {
      const stored = reusedPath ?? path
      const url = await compatUrlFor(stored)
      state.progress = 1
      state.status = 'completed'
      options.onProgress?.(1)
      return reusedPath ? { path: stored, url, reused: true } : { path: stored, url }
    },
    (error: unknown) => {
      clearStall()
      if (aborted || error instanceof UploadAbortedError) {
        state.status = 'aborted'
        throw new UploadAbortedError()
      }
      state.status = 'error'
      state.error = error instanceof Error ? error.message : 'Upload failed'
      throw error
    },
  )
  // Callers that drop the handle leave no unhandled rejection behind.
  result.catch(() => {})

  return {
    path,
    state,
    result,
    abort() {
      if (aborted || state.status === 'completed') return
      aborted = true
      xhr?.abort()
    },
  }
}
