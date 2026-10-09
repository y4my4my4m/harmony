import { defineStore } from 'pinia'
import { computed, markRaw, ref, toRaw } from 'vue'
import { useToast } from 'vue-toastification'
import type { FileContent, Message, MessagePart } from '@/types'
import { supabase } from '@/supabase'
import { i18n } from '@/i18n'
import { debug } from '@/utils/debug'
import {
  MESSAGE_MEDIA_BUCKET,
  attachmentFileType,
  clearLocalMediaSources,
  mediaRoomOfPath,
  messageMediaPath,
  placeUploadInRoom,
  preloadRemoteImageSource,
  registerLocalMediaSource,
  releaseLocalMediaSource,
} from '@/services/privateMedia'
import {
  UploadAbortedError,
  forgetMessageMediaUpload,
  resetMessageMediaUploads,
  startMessageMediaUpload,
  type MessageMediaUpload,
} from '@/services/messageMediaUpload'
import { createTempMessageId, getRandomId } from '@/stores/shared/optimisticMessages'
import { sendToTarget, targetKey, targetMediaRoom, type MessageTarget } from '@/stores/shared/sendToTarget'
import { classifySendFailure } from '@/utils/sendFailure'
import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'
import { useServerWelcomeStore } from '@/stores/useServerWelcome'
import { useAuthStore } from '@/stores/auth'

/**
 * Messages with attachments, from Enter until the message is persisted.
 *
 * A job holds the target fixed at Enter, the text parts and the attachments. Each
 * attachment has an object name reserved in the target room; uploads run
 * independently of the component tree. The pending row (id `temp-…`, the job's
 * client_nonce) renders from local object URLs. Once every upload completes the
 * message goes out through sendToTarget with that row id and nonce, so the
 * store's optimistic row, and then the persisted row, take the pending row's
 * place. Sends to one target leave in Enter order.
 *
 * A failed upload or send leaves the row failed; retry re-uploads only the
 * attachments that did not complete, discard (also offered while uploading)
 * aborts uploads and deletes the objects already stored. A slowmode rejection is
 * waited out and re-sent. Jobs belong to the session that queued them: sign-out
 * resets the outbox, and a job whose uploader is no longer signed in is not sent.
 */

export interface OutboxAttachment {
  file: Blob
  /** Name on the file part. */
  name: string
  type: string
  size: number
  /** Object URL of `file`; owned by the outbox once enqueued. */
  previewUrl?: string
  /** Composer upload of `file`, running or settled. */
  upload?: MessageMediaUpload | null
  /** Object name and compat URL of a completed composer upload. */
  uploadedPath?: string
  uploadedUrl?: string
}

export interface OutboxRequest {
  target: MessageTarget
  /** profiles.id; user_id of the row. */
  authorId: string
  /** auth uid; third segment of reserved object names. */
  uploaderId: string
  replyTo?: string
  /** Shown on the pending row until `parsedTextParts` settles. */
  textParts: MessagePart[]
  parsedTextParts?: Promise<MessagePart[]>
  attachments: OutboxAttachment[]
  extraMetadata?: Record<string, unknown>
}

export type OutboxFileStatus = 'pending' | 'uploading' | 'completed' | 'error'

export interface OutboxFile {
  name: string
  /** Name the object name's extension derives from. */
  sourceName: string
  type: string
  size: number
  fileType: 'image' | 'video' | 'audio' | 'file'
  file: Blob
  previewUrl: string
  /** Reserved object name. */
  path: string
  /** Compat URL once uploaded. */
  url: string | null
  status: OutboxFileStatus
  error: string | null
  upload: MessageMediaUpload | null
}

/**
 * uploading  uploads running, or done and waiting for parsing or an earlier job
 * waiting    a slowmode rejection is being waited out; no insert in flight
 * sending    the insert is in flight; the job cannot be discarded
 */
export type OutboxJobStatus = 'uploading' | 'waiting' | 'sending' | 'failed'

export interface OutboxJob {
  /** Id of the pending row and of the store's optimistic row. */
  id: string
  clientNonce: string
  seq: number
  target: MessageTarget
  /** targetKey(target). */
  key: string
  room: string
  authorId: string
  uploaderId: string
  replyTo?: string
  textParts: MessagePart[]
  extraMetadata?: Record<string, unknown>
  files: OutboxFile[]
  status: OutboxJobStatus
  createdAt: Date
}

interface JobGate {
  /** Resolves when the job is sent, fails or is discarded. */
  settled: Promise<void>
  settle: () => void
}

const NO_ROWS: readonly Message[] = Object.freeze([])

/** Re-sends after slowmode rejections before the job fails. */
const SLOWMODE_RETRIES = 3
/** Added to the wait the database reports, ms; its count is whole seconds. */
const SLOWMODE_MARGIN_MS = 500

/** Seconds a slowmode rejection asks to wait; null for any other error. */
function slowmodeWaitSeconds(error: unknown): number | null {
  const e = error as { retryAfterSeconds?: unknown; code?: unknown; message?: unknown } | null
  if (typeof e?.retryAfterSeconds === 'number') return e.retryAfterSeconds
  const match = /SLOWMODE_ACTIVE:(\d+)/.exec(`${e?.code ?? ''} ${e?.message ?? ''}`)
  return match ? Number(match[1]) : null
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function pendingFilePart(file: OutboxFile): FileContent {
  return {
    type: 'file',
    url: file.previewUrl,
    path: file.path,
    fileType: file.fileType,
    fileName: file.name,
    fileSize: file.size,
  }
}

function pendingRow(job: OutboxJob): Message {
  return {
    id: job.id,
    created_at: job.createdAt,
    ...(job.target.kind === 'channel'
      ? { channel_id: job.target.channelId }
      : { conversation_id: job.target.conversationId }),
    user_id: job.authorId,
    content: [...job.textParts, ...job.files.map(pendingFilePart)],
    reply_to: job.replyTo,
    reactions: [],
    metadata: { ...(job.extraMetadata ?? {}), client_nonce: job.clientNonce },
    sending: job.status !== 'failed',
    failed: job.status === 'failed',
  }
}

/**
 * `messages` with the pending rows appended. A row the store already holds, by id
 * (its optimistic copy) or by client_nonce (the persisted message), is left out.
 */
export function withPendingRows(messages: Message[], rows: readonly Message[]): Message[] {
  if (rows.length === 0) return messages
  const ids = new Set<string>()
  const nonces = new Set<string>()
  for (const message of messages) {
    ids.add(message.id)
    const nonce = message.metadata?.client_nonce
    if (typeof nonce === 'string') nonces.add(nonce)
  }
  const extra = rows.filter((row) => !ids.has(row.id) && !nonces.has(row.metadata?.client_nonce))
  return extra.length > 0 ? [...messages, ...extra] : messages
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useOutboxStore = defineStore('outbox', () => {
  const jobs = ref<OutboxJob[]>([])
  const gates = new Map<string, JobGate>()
  const parsing = new Map<string, Promise<unknown>>()
  /** Object URLs of sent video, audio and unpreloaded images; revoked on reset. */
  const retained = new Map<string, string>()
  let nextSeq = 0

  const t = (key: string, params?: Record<string, unknown>) => i18n.global.t(key, params ?? {}) as string

  const rowsByTarget = computed(() => {
    const byTarget = new Map<string, Message[]>()
    for (const job of jobs.value) {
      const rows = byTarget.get(job.key) ?? []
      rows.push(pendingRow(job))
      byTarget.set(job.key, rows)
    }
    return byTarget
  })

  /** Pending rows of a target key, in Enter order. */
  const rowsFor = (key: string | null | undefined): readonly Message[] =>
    (key && rowsByTarget.value.get(key)) || NO_ROWS

  const has = (id: string): boolean => jobs.value.some((job) => job.id === id)

  /** A job is uploading or sending. */
  const hasPendingUploads = computed(() => jobs.value.some((job) => job.status !== 'failed'))

  const find = (id: string): OutboxJob | undefined => jobs.value.find((job) => job.id === id)

  function arm(id: string): void {
    let settle!: () => void
    const settled = new Promise<void>((resolve) => { settle = resolve })
    gates.set(id, { settled, settle })
  }

  function settle(id: string): void {
    gates.get(id)?.settle()
  }

  function adopt(attachment: OutboxAttachment, room: string, uploaderId: string, jobId: string): OutboxFile {
    const sourceName = (attachment.file as File).name || attachment.name
    const file: OutboxFile = {
      name: attachment.name,
      sourceName,
      type: attachment.type,
      size: attachment.size,
      fileType: attachmentFileType(attachment.type || ''),
      file: attachment.file,
      previewUrl: attachment.previewUrl || URL.createObjectURL(attachment.file),
      path: '',
      url: null,
      status: 'pending',
      error: null,
      upload: null,
    }
    const handle = attachment.upload
    if (attachment.uploadedPath && attachment.uploadedUrl) {
      file.path = attachment.uploadedPath
      file.url = attachment.uploadedUrl
      file.status = 'completed'
    } else if (handle && handle.state.status !== 'error' && handle.state.status !== 'aborted'
        && mediaRoomOfPath(handle.path) === room) {
      file.path = handle.path
      file.status = 'uploading'
      file.upload = markRaw(handle)
      handle.state.cancel = () => discard(jobId)
    } else {
      if (handle) {
        handle.abort()
        forgetMessageMediaUpload(handle.path)
      }
      file.path = messageMediaPath(room, uploaderId, sourceName)
    }
    registerLocalMediaSource(file.path, file.previewUrl)
    return file
  }

  /** Queues a message with attachments; returns the pending row id. */
  function enqueue(request: OutboxRequest): string {
    const room = targetMediaRoom(request.target)
    if (!room) throw new Error('Attachments need a channel or conversation')
    const id = createTempMessageId()
    jobs.value.push({
      id,
      clientNonce: getRandomId(),
      seq: nextSeq++,
      target: request.target,
      key: targetKey(request.target),
      room,
      authorId: request.authorId,
      uploaderId: request.uploaderId,
      replyTo: request.replyTo || undefined,
      textParts: request.textParts,
      extraMetadata: request.extraMetadata,
      files: request.attachments.map((attachment) => adopt(attachment, room, request.uploaderId, id)),
      status: 'uploading',
      createdAt: new Date(),
    })
    if (request.parsedTextParts) {
      // The pending row shows the parsed text as soon as it is ready.
      parsing.set(id, request.parsedTextParts.then(
        (parts) => {
          const job = find(id)
          if (job && job.status !== 'sending') job.textParts = parts
        },
        (error: unknown) => debug.warn('Outbox: text parsing failed; sending the text as typed', error),
      ))
    }
    arm(id)
    void run(id)
    return id
  }

  async function uploadFile(job: OutboxJob, file: OutboxFile): Promise<boolean> {
    if (file.status === 'completed') return true
    if (!file.upload) {
      file.upload = markRaw(startMessageMediaUpload(file.path, file.file, { validate: true }))
      const id = job.id
      file.upload.state.cancel = () => discard(id)
    }
    file.status = 'uploading'
    const upload = file.upload
    try {
      const uploaded = await upload.result
      if (file.upload !== upload) return false
      file.url = uploaded.url
      file.status = 'completed'
      return true
    } catch (error) {
      if (file.upload !== upload || error instanceof UploadAbortedError) return false
      file.status = 'error'
      file.error = errorMessage(error)
      file.upload = null
      useToast().error(t('message.upload.failedToast', { name: file.name, reason: file.error }))
      return false
    }
  }

  /** True once every upload completed; false at the first failure. */
  function uploadAll(job: OutboxJob): Promise<boolean> {
    const uploads = job.files.map((file) => uploadFile(job, file))
    return new Promise((resolve) => {
      let left = uploads.length
      if (left === 0) resolve(true)
      for (const upload of uploads) {
        void upload.then((ok) => {
          if (!ok) resolve(false)
          else if (--left === 0) resolve(true)
        })
      }
    })
  }

  /** Waits for the unsettled jobs of the same target enqueued earlier. */
  async function waitForTurn(job: OutboxJob): Promise<void> {
    const earlier = jobs.value
      .filter((other) => other.key === job.key && other.seq < job.seq && other.status !== 'failed')
      .map((other) => gates.get(other.id)?.settled)
    await Promise.all(earlier)
  }

  async function fileParts(job: OutboxJob): Promise<FileContent[]> {
    const parts: FileContent[] = []
    for (const file of job.files) {
      // A composer upload finished in the room the composer showed before the send.
      if (mediaRoomOfPath(file.path) !== job.room) {
        const placed = await placeUploadInRoom({ path: file.path, url: file.url ?? '' }, job.room)
        releaseLocalMediaSource(file.path)
        forgetMessageMediaUpload(file.path)
        file.path = placed.path
        file.url = placed.url
        registerLocalMediaSource(file.path, file.previewUrl)
      }
      parts.push({
        type: 'file',
        url: file.url ?? '',
        path: file.path,
        fileType: file.fileType,
        fileName: file.name,
        fileSize: file.size,
      })
    }
    return parts
  }

  function removeStoreRow(job: OutboxJob): void {
    if (job.target.kind === 'channel') useChatStore().discardFailedMessage(job.id)
    else useDMStore().discardFailedDMMessage(job.id)
  }

  function fail(job: OutboxJob): void {
    job.status = 'failed'
    settle(job.id)
  }

  function notifySendFailure(error: unknown, target: MessageTarget): void {
    const toast = useToast()
    const msg = errorMessage(error)
    switch (classifySendFailure(error)) {
      case 'encryption-required':
        if (!(error as { reason?: unknown })?.reason) toast.error(msg || 'This channel requires end-to-end encryption.')
        break
      case 'encryption':
      case 'moderation':
        toast.error(msg)
        break
      case 'recipient-deleted':
        toast.error(t('dm.recipientDeleted'))
        break
      case 'slowmode':
        toast.info(msg)
        break
      case 'rules': {
        const details = (error as { details?: { serverId?: string } })?.details
        void useServerWelcomeStore().handleRulesRejection(
          details?.serverId ?? (target.kind === 'channel' ? target.serverId : null))
        break
      }
      default:
        debug.error('Outbox send failed:', error)
    }
  }

  /**
   * An image's local source gives way once its remote source is in the image
   * cache. Video and audio keep theirs until sign-out: a new source resets a media
   * element's intrinsic size and playback. So does an image whose remote source
   * did not load.
   */
  async function releaseLocal(file: Pick<OutboxFile, 'path' | 'url' | 'previewUrl' | 'fileType'>): Promise<void> {
    const keep = file.fileType === 'video' || file.fileType === 'audio'
      || (file.fileType === 'image' && !await preloadRemoteImageSource({ path: file.path, url: file.url ?? undefined }))
    if (keep) {
      retained.set(file.path, file.previewUrl)
      return
    }
    releaseLocalMediaSource(file.path)
    URL.revokeObjectURL(file.previewUrl)
  }

  function complete(job: OutboxJob): void {
    const index = jobs.value.findIndex((other) => other.id === job.id)
    if (index !== -1) jobs.value.splice(index, 1)
    settle(job.id)
    gates.delete(job.id)
    for (const file of job.files) {
      forgetMessageMediaUpload(file.path)
      void releaseLocal({ path: file.path, url: file.url, previewUrl: file.previewUrl, fileType: file.fileType })
    }
  }

  async function send(job: OutboxJob): Promise<void> {
    await parsing.get(job.id)
    parsing.delete(job.id)
    if (!find(job.id)) return
    job.status = 'sending'

    let parts: MessagePart[]
    try {
      parts = [...toRaw(job.textParts), ...await fileParts(job)]
    } catch (error) {
      debug.error('Outbox: placing an attachment in the target room failed', error)
      fail(job)
      return
    }

    const raw = toRaw(job)
    for (let attempt = 0; ; attempt++) {
      // The objects and the message belong to the uploader's account.
      if (useAuthStore().session?.user?.id !== raw.uploaderId) {
        debug.warn('Outbox: the account that queued the message is signed out; not sending')
        fail(job)
        return
      }
      try {
        const outcome = await sendToTarget(raw.target, raw.authorId, parts, raw.replyTo, {
          tempId: raw.id,
          clientNonce: raw.clientNonce,
          extraMetadata: raw.extraMetadata,
        })
        if (outcome === 'ok') {
          complete(job)
          return
        }
        removeStoreRow(job)
        fail(job)
        return
      } catch (error) {
        removeStoreRow(job)
        const wait = slowmodeWaitSeconds(error)
        if (wait !== null && attempt < SLOWMODE_RETRIES) {
          useToast().info(errorMessage(error))
          job.status = 'waiting'
          await delay(wait * 1000 + SLOWMODE_MARGIN_MS)
          if (find(job.id)?.status !== 'waiting') return
          job.status = 'sending'
          continue
        }
        fail(job)
        notifySendFailure(error, job.target)
        return
      }
    }
  }

  async function run(id: string): Promise<void> {
    const job = find(id)
    if (!job) return
    job.status = 'uploading'
    const uploaded = await uploadAll(job)
    if (!find(id)) return
    if (!uploaded) {
      fail(job)
      return
    }
    await waitForTurn(job)
    if (!find(id)) return
    await send(job)
  }

  /** Re-uploads the attachments that did not complete, then sends. */
  function retry(id: string): void {
    const job = find(id)
    if (!job || job.status !== 'failed') return
    for (const file of job.files) {
      if (file.status !== 'error') continue
      // A failed request may still have stored the object; a fresh name avoids
      // the upsert-off conflict.
      releaseLocalMediaSource(file.path)
      forgetMessageMediaUpload(file.path)
      file.path = messageMediaPath(job.room, job.uploaderId, file.sourceName)
      registerLocalMediaSource(file.path, file.previewUrl)
      file.status = 'pending'
      file.error = null
      file.upload = null
    }
    arm(id)
    void run(id)
  }

  /**
   * Drops a job that is not sending: aborts its uploads, revokes its object URLs and
   * deletes the objects it stored. The message_media DELETE policy admits the
   * uploader; the unreferenced-object sweep collects what a refused delete leaves.
   */
  function discard(id: string): void {
    const index = jobs.value.findIndex((job) => job.id === id)
    if (index === -1) return
    const job = jobs.value[index]
    if (job.status === 'sending') return
    jobs.value.splice(index, 1)
    settle(id)
    gates.delete(id)
    parsing.delete(id)

    const stored: string[] = []
    for (const file of job.files) {
      file.upload?.abort()
      if (file.status === 'completed') stored.push(file.path)
      forgetMessageMediaUpload(file.path)
      releaseLocalMediaSource(file.path)
      URL.revokeObjectURL(file.previewUrl)
    }
    removeStoreRow(job)
    if (stored.length > 0) {
      supabase.storage.from(MESSAGE_MEDIA_BUCKET).remove(stored).then(
        ({ error }) => { if (error) debug.warn('Outbox: deleting discarded attachments failed', error) },
        (error: unknown) => debug.warn('Outbox: deleting discarded attachments failed', error),
      )
    }
  }

  /**
   * Sign-out: aborts every upload, revokes every object URL and drops the jobs and
   * the upload and local-source registries. Objects already stored are left to the
   * unreferenced-object sweep.
   */
  function reset(): void {
    for (const job of jobs.value) {
      for (const file of job.files) {
        file.upload?.abort()
        URL.revokeObjectURL(file.previewUrl)
      }
    }
    for (const url of retained.values()) URL.revokeObjectURL(url)
    retained.clear()
    jobs.value = []
    for (const gate of gates.values()) gate.settle()
    gates.clear()
    parsing.clear()
    resetMessageMediaUploads()
    clearLocalMediaSources()
  }

  if (typeof window !== 'undefined') {
    // A non-empty returnValue prompts in browsers that predate preventDefault() on
    // beforeunload; none of them shows the text.
    window.addEventListener('beforeunload', (event) => {
      if (!hasPendingUploads.value) return
      event.preventDefault()
      event.returnValue = 'You have messages uploading. Are you sure you want to leave?'
    })
  }

  return { jobs, rowsFor, has, hasPendingUploads, enqueue, retry, discard, reset }
})
