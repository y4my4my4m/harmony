import { reactive, toRaw, watch } from 'vue'
import type { FilePreviewData } from '@/components/FilePreview.vue'
import { forgetMessageMediaUpload } from '@/services/messageMediaUpload'
import { compatUrlFor, messageMediaReferenceUrl } from '@/services/privateMedia'
import { userStorage } from '@/utils/userScopedStorage'

/**
 * Attachments of unsent message drafts, per account and draft key (drafts.ts makeKey).
 *
 * A composer shows the list of its draft key. The list outlives the composer: previews,
 * alt text, spoiler and temporary flags and running uploads stay with the draft through a
 * view change, as its text does. Module state for the session; File and Blob objects do
 * not serialize.
 *
 * Completed uploads are also kept in user-scoped storage by object name. A reload restores
 * those younger than RESTORE_MAX_AGE_MS: unsent message_media objects are deleted after 24 h
 * (sweep-message-media, SWEEP_MIN_AGE in messageMediaCleanupHandler.ts).
 */

const STORAGE_KEY = 'message-draft-attachments'
const SAVE_DEBOUNCE_MS = 500
/** 20 h, inside the sweep's 24 h. */
export const RESTORE_MAX_AGE_MS = 20 * 60 * 60 * 1000
const LOCAL_PREFIX = 'local:'

interface StoredAttachment {
  name: string
  type: string
  size: number
  /** message_media object name. */
  path: string
  /** Epoch ms the attachment was first kept as completed. */
  savedAt: number
  altText?: string
  temporary?: boolean
  reused?: boolean
  fromDrive?: boolean
}

const EMPTY = Object.freeze([]) as unknown as FilePreviewData[]
/** `<account>\n<draft key>` to attachments. Elements are stored raw; reads return proxies. */
const lists = reactive(new Map<string, FilePreviewData[]>()) as Map<string, FilePreviewData[]>
/** Scoped keys a mounted composer shows, with the number of such composers. */
const shown = new Map<string, number>()
const savedAt = new WeakMap<FilePreviewData, number>()
const restoredAccounts = new Set<string>()
let lastAccount: string | null = null
let localSeq = 0
let saveTimer: ReturnType<typeof setTimeout> | null = null

const account = () => userStorage.getCurrentUser() ?? ''
const scoped = (key: string, who = account()) => `${who}\n${key}`
const accountOf = (scopedKey: string) => scopedKey.slice(0, scopedKey.indexOf('\n'))
const draftKeyOf = (scopedKey: string) => scopedKey.slice(scopedKey.indexOf('\n') + 1)
const isMedia = (type: string) => type.startsWith('image/') || type.startsWith('video/')

/** A key for a composer without a draft; its attachments go with that composer. */
export function localDraftKey(): string {
  localSeq += 1
  return `${LOCAL_PREFIX}${localSeq}`
}

/** Attachments of the signed-in account's draft `key`, in order. */
export function draftAttachments(key: string): FilePreviewData[] {
  return lists.get(scoped(key)) ?? EMPTY
}

export function setDraftAttachments(key: string, files: readonly FilePreviewData[]): void {
  const k = scoped(key)
  if (files.length === 0) lists.delete(k)
  else lists.set(k, files.map((file) => toRaw(file)))
}

export function addDraftAttachments(key: string, files: readonly FilePreviewData[]): void {
  if (files.length > 0) setDraftAttachments(key, [...draftAttachments(key), ...files])
}

/** Scoped key of the draft holding `file`; null once it is sent, removed or discarded. */
function holderOf(file: FilePreviewData): string | null {
  const raw = toRaw(file)
  for (const [k, list] of toRaw(lists)) {
    if (list.some((entry) => entry === raw)) return k
  }
  return null
}

export function holdsDraftAttachment(file: FilePreviewData): boolean {
  return holderOf(file) !== null
}

/** The draft holding `file` is on screen in a mounted composer. */
export function draftAttachmentShown(file: FilePreviewData): boolean {
  const k = holderOf(file)
  return k !== null && (shown.get(k) ?? 0) > 0
}

/** Takes `file` out of the draft holding it and frees it. */
export function removeDraftAttachment(file: FilePreviewData): void {
  const k = holderOf(file)
  if (k === null) return
  const raw = toRaw(file)
  const rest = (toRaw(lists).get(k) ?? []).filter((entry) => entry !== raw)
  if (rest.length === 0) lists.delete(k)
  else lists.set(k, rest)
  releaseAttachment(file)
}

/** Frees an attachment's object URL, running upload and upload state. */
export function releaseAttachment(file: FilePreviewData): void {
  if (file.preview?.startsWith('blob:')) URL.revokeObjectURL(file.preview)
  file.upload?.abort()
  forgetMessageMediaUpload(file.upload?.path)
}

function dropScoped(k: string): void {
  const list = toRaw(lists).get(k)
  if (!list) return
  lists.delete(k)
  list.forEach(releaseAttachment)
}

export function discardDraftAttachments(key: string): void {
  dropScoped(scoped(key))
}

/** Drops every draft's attachments and frees them. */
export function resetDraftAttachments(): void {
  for (const k of [...toRaw(lists).keys()]) dropScoped(k)
  shown.clear()
  restoredAccounts.clear()
  lastAccount = null
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
}

/**
 * A composer shows draft `key` until the returned function is called. The first composer of
 * an account restores its stored attachments; another account's drafts are dropped.
 */
export function openDraftAttachments(key: string): () => void {
  const who = account()
  if (who && lastAccount && who !== lastAccount) {
    for (const k of [...toRaw(lists).keys()]) {
      if (accountOf(k) !== who) dropScoped(k)
    }
  }
  if (who) lastAccount = who
  restoreStored(who)

  const k = scoped(key, who)
  shown.set(k, (shown.get(k) ?? 0) + 1)
  let closed = false
  return () => {
    if (closed) return
    closed = true
    const count = (shown.get(k) ?? 0) - 1
    if (count > 0) shown.set(k, count)
    else shown.delete(k)
  }
}

function isStoredAttachment(value: unknown): value is StoredAttachment {
  const v = value as StoredAttachment
  return !!v && typeof v.name === 'string' && typeof v.type === 'string' && typeof v.size === 'number'
    && typeof v.path === 'string' && v.path.length > 0 && typeof v.savedAt === 'number'
}

function readStored(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(userStorage.getItem(STORAGE_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function restoreStored(who: string): void {
  if (!who || restoredAccounts.has(who)) return
  restoredAccounts.add(who)
  const now = Date.now()
  for (const [key, entries] of Object.entries(readStored())) {
    const k = scoped(key, who)
    if (key.startsWith(LOCAL_PREFIX) || !Array.isArray(entries) || lists.has(k)) continue
    const files = entries
      .filter(isStoredAttachment)
      .filter((entry) => now - entry.savedAt < RESTORE_MAX_AGE_MS)
      .map((entry): FilePreviewData => {
        const file: FilePreviewData = {
          file: new File([], entry.name, { type: entry.type }),
          name: entry.name,
          size: entry.size,
          type: entry.type,
          uploadStatus: 'completed',
          uploadProgress: 100,
          uploadedPath: entry.path,
          uploadedUrl: messageMediaReferenceUrl(entry.path),
          ...(entry.altText ? { altText: entry.altText } : {}),
          ...(entry.temporary ? { temporary: true } : {}),
          ...(entry.reused ? { reused: true } : {}),
          ...(entry.fromDrive ? { fromDrive: true } : {}),
        }
        savedAt.set(file, entry.savedAt)
        return file
      })
    if (files.length === 0) continue
    lists.set(k, files)
    files.forEach((file) => void signRestored(file))
  }
}

/** Signs a restored attachment's compat URL; drops the attachment when its object is gone. */
async function signRestored(file: FilePreviewData): Promise<void> {
  const path = file.uploadedPath as string
  const url = await compatUrlFor(path)
  const k = holderOf(file)
  if (!k) return
  // compatUrlFor answers the unsigned reference URL when signing fails.
  if (url === messageMediaReferenceUrl(path)) {
    const rest = (toRaw(lists).get(k) ?? []).filter((entry) => entry !== file)
    if (rest.length > 0) lists.set(k, rest)
    else lists.delete(k)
    return
  }
  const live = reactive(file)
  live.uploadedUrl = url
  if (isMedia(file.type)) live.preview = url
}

/** Completed attachments of `who`'s drafts, by draft key. */
function storable(who: string, stamp?: (file: FilePreviewData) => number): Record<string, StoredAttachment[]> {
  const record: Record<string, StoredAttachment[]> = {}
  for (const [k, list] of lists) {
    const key = draftKeyOf(k)
    if (accountOf(k) !== who || key.startsWith(LOCAL_PREFIX)) continue
    const kept = list
      .filter((file) => file.uploadStatus === 'completed' && !!file.uploadedPath)
      .map((file): StoredAttachment => ({
        name: file.name,
        type: file.type,
        size: file.size,
        path: file.uploadedPath as string,
        savedAt: stamp ? stamp(toRaw(file)) : 0,
        ...(file.altText ? { altText: file.altText } : {}),
        ...(file.temporary ? { temporary: true } : {}),
        ...(file.reused ? { reused: true } : {}),
        ...(file.fromDrive ? { fromDrive: true } : {}),
      }))
    if (kept.length > 0) record[key] = kept
  }
  return record
}

function save(): void {
  saveTimer = null
  const who = account()
  // An account's stored drafts are read before they are first written.
  if (!who || !restoredAccounts.has(who)) return
  const now = Date.now()
  const record = storable(who, (file) => {
    const at = savedAt.get(file) ?? now
    savedAt.set(file, at)
    return at
  })
  try {
    if (Object.keys(record).length > 0) userStorage.setItem(STORAGE_KEY, JSON.stringify(record))
    else userStorage.removeItem(STORAGE_KEY)
  } catch { /* quota exceeded: the session copy remains */ }
}

watch(() => JSON.stringify(storable(account())), () => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS)
})

// A reload loses uploads still running in any draft, shown or not.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    const uploading = [...toRaw(lists).values()].some((list) => list.some((file) => file.uploadStatus === 'uploading'))
    if (!uploading) return
    event.preventDefault()
    event.returnValue = ''
  })
}
