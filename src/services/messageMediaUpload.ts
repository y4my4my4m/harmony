import { shallowReactive } from 'vue'
import { i18n } from '@/i18n'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { getBucketLimits, validateImageUpload } from '@/utils/uploadValidation'
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
import {
  DEFAULT_CACHE_CONTROL,
  StorageUploadError,
  UploadAbortedError,
  listRefusedUpload,
  newUploadState,
  startStorageUpload,
  type StorageUpload,
  type UploadState,
} from '@/services/uploads/storageUpload'
import { UploadLimitError, checkUploadLimit, getUploadLimit } from '@/services/uploads/uploadLimit'
import { stripMediaMetadata } from '@/utils/stripMetadata'

export { UPLOAD_STALL_MS, UploadAbortedError } from '@/services/uploads/storageUpload'

/**
 * Chat attachment and Drive uploads into message_media, through the shared storage upload
 * (services/uploads/storageUpload.ts): progress, abort, the transfers indicator and resumable
 * transfer of large files.
 *
 * On an instance with Drive the upload carries its SHA-256 and name (none for encrypted
 * rooms), and a file the account already keeps in Drive with the same SHA-256 is not sent
 * again: the result names that object (`reused`).
 *
 * Photo and video metadata is removed before the hash unless `keepMetadata`: the SHA-256 and
 * size describe the bytes stored.
 *
 * Upload state is kept per object name and is reactive, so any render of a part
 * naming the object reads its progress.
 */

export type MessageMediaUploadStatus = UploadState['status']

export type MessageMediaUploadState = UploadState

export interface MessageMediaUploadResult extends UploadedMessageMedia {
  /** The bytes were in Drive already; `path` names that object, not the planned one. */
  reused?: boolean
}

export interface MessageMediaUploadOptions {
  validate?: boolean
  onProgress?: (fraction: number) => void
  /** Drive name of the file; omitted for encrypted rooms. */
  name?: string
  /** Name in the transfers indicator; `name`, else the file's own name, by default. */
  label?: string
  /** Kept only until drive_ephemeral_days. */
  ephemeral?: boolean
  /** Send the existing Drive file with the same bytes instead of uploading them again. */
  reuse?: boolean
  /** Drive folder of the new file. */
  folder?: string | null
  /** An interrupted upload of the same file under this key is continued (storageUpload.ts). */
  resumeKey?: string
  /** The starting page shows the progress (storageUpload.ts ownProgress). */
  ownProgress?: boolean
  /** Upload the photo or video with its location, camera and other metadata. */
  keepMetadata?: boolean
}

export interface MessageMediaUpload {
  readonly path: string
  readonly state: MessageMediaUploadState
  /** Rejects with UploadAbortedError after abort(). */
  readonly result: Promise<MessageMediaUploadResult>
  abort(): void
}

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
  void getUploadLimit().catch(() => {})
  void driveAvailable()
}

/**
 * Deletes a completed upload no message names. A refused delete leaves the object to the
 * unreferenced-object sweep.
 */
export async function discardMessageMediaUpload(path: string): Promise<void> {
  try {
    const { error } = await supabase.storage.from(MESSAGE_MEDIA_BUCKET).remove([path])
    if (error) throw error
  } catch (error) {
    debug.warn('Deleting a replaced upload failed', error)
  }
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

/**
 * Uploads `file` as object `path` of message_media. The path names the target
 * room and the uploader's auth uid (see privateMedia.ts); storage RLS checks both.
 */
export function startMessageMediaUpload(
  path: string,
  file: Blob,
  options: MessageMediaUploadOptions = {},
): MessageMediaUpload {
  const state = newUploadState(file.size)
  states.set(path, state)
  let inner: StorageUpload | null = null
  let aborted = false

  const label = options.label ?? options.name ?? ((file as File).name || undefined)

  const transfer = async (): Promise<{ path: string; reused: boolean }> => {
    if (!isMessageMediaPath(path)) throw new Error('Attachments need a channel or conversation')
    // Validation (bucket limits) and the Drive probe are independent reads, once per session each.
    const drive = driveAvailable()
    const source = options.keepMetadata ? file : await stripMediaMetadata(file)
    if (options.validate) await validateChatUpload(source)
    // Before the hash: a file over the account's limit is not read.
    try {
      await checkUploadLimit(MESSAGE_MEDIA_BUCKET, source, label)
    } catch (error) {
      if (error instanceof UploadLimitError) listRefusedUpload(label, source.size, error.message)
      throw error
    }
    const metadata: DriveUploadMetadata = {}
    if (await drive) {
      metadata.sha256 = await sha256OfBlob(source)
      if (options.name) metadata.name = options.name
      if (options.ephemeral) metadata.ephemeral = true
      if (options.folder) metadata.folder = options.folder
      if (options.reuse !== false) {
        const existing = (await findDriveFilesByHash(metadata.sha256).catch(() => []))
          .find((f) => f.bucket === MESSAGE_MEDIA_BUCKET && f.state === 'drive' && f.size_bytes === source.size)
        if (existing) return { path: existing.path, reused: true }
      }
    }
    if (aborted) throw new UploadAbortedError()

    inner = startStorageUpload({
      bucket: MESSAGE_MEDIA_BUCKET,
      path,
      file: source,
      keepMetadata: options.keepMetadata,
      cacheControl: DEFAULT_CACHE_CONTROL,
      metadata: metadata as Record<string, unknown>,
      label,
      onProgress: options.onProgress,
      resumeKey: options.resumeKey,
      ownProgress: options.ownProgress,
      state,
    })
    try {
      return { path: (await inner.result).path, reused: false }
    } catch (error) {
      // A blocked hash surfaces as storage-api's generic row-level security refusal.
      if (metadata.sha256 && error instanceof StorageUploadError && error.status < 500
        && await isDriveHashBlocked(metadata.sha256).catch(() => false)) {
        throw new Error(i18n.global.t('drive.errors.blocked') as string)
      }
      throw error
    }
  }

  const result = transfer().then(
    async ({ path: stored, reused }) => {
      if (stored !== path && !reused) {
        // A continued upload: the state follows the object it names.
        states.delete(path)
        states.set(stored, state)
      }
      const url = await compatUrlFor(stored)
      state.progress = 1
      state.status = 'completed'
      options.onProgress?.(1)
      return reused ? { path: stored, url, reused: true } : { path: stored, url }
    },
    (error: unknown) => {
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
      inner?.abort()
    },
  }
}
