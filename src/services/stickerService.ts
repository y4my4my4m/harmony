/**
 * Custom stickers: the stickers table and bucket (20261031200001_custom_stickers.sql).
 *
 * Rows are read directly where stickers_select_visible shows them (uploader is not granted) and
 * written through create_sticker, update_sticker and delete_sticker; existing_sticker_ids
 * answers any sticker's url by id. Objects live in bucket stickers at
 * server/<server id>/<uuid>.<ext>, instance/<uuid>.<ext> or user/<profile id>/<uuid>.<ext>.
 */
import { v4 as uuidv4 } from 'uuid'
import { supabase } from '@/supabase'
import { i18n } from '@/i18n'
import { debug } from '@/utils/debug'
import { prepareImageUpload, type PreparedImage } from '@/utils/imageResize'
import {
  UploadRejectedError,
  formatBytes,
  getBucketLimits,
  humanizeUploadError,
  imageSourceError,
  validateImageUpload,
} from '@/utils/uploadValidation'
import { storePublicImage } from '@/services/uploads/storageUpload'
import {
  STICKER_DESCRIPTION_MAX,
  STICKER_MAX_BYTES,
  STICKER_MAX_DURATION_MS,
  STICKER_MAX_SIDE,
  STICKER_NAME_MAX,
  STICKER_NAME_MIN,
  readStickerImageInfo,
  stickerFileProblem,
  stickerTextProblem,
  type StickerFileProblem,
  type StickerImageInfo,
  type StickerTextProblem,
} from '@/utils/stickerImage'
import { stickerLimitOf, type StickerScope } from '@/utils/stickerLimits'

export type { StickerScope }

export const STICKER_BUCKET = 'stickers'

export interface Sticker {
  id: string
  scope: StickerScope
  server_id: string | null
  owner_id: string | null
  name: string
  description: string
  url: string
  path: string
  mime_type: string
  file_size: number
  width: number
  height: number
  duration_ms: number | null
  created_at: string
}

const COLUMNS =
  'id, scope, server_id, owner_id, name, description, url, path, mime_type, file_size, width, height, duration_ms, created_at'

const STICKER_EXTENSIONS = new Set(['png', 'apng', 'webp', 'gif'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const t = (key: string, named?: Record<string, unknown>) => i18n.global.t(key, named ?? {}) as string

function byName(a: Sticker, b: Sticker): number {
  return a.name.localeCompare(b.name)
}

export async function listServerStickers(serverId: string): Promise<Sticker[]> {
  const { data, error } = await supabase
    .from('stickers')
    .select(COLUMNS)
    .eq('scope', 'server')
    .eq('server_id', serverId)
  if (error) throw error
  return ((data ?? []) as Sticker[]).sort(byName)
}

export async function listInstanceStickers(): Promise<Sticker[]> {
  const { data, error } = await supabase.from('stickers').select(COLUMNS).eq('scope', 'instance')
  if (error) throw error
  return ((data ?? []) as Sticker[]).sort(byName)
}

export async function listMyStickers(profileId: string): Promise<Sticker[]> {
  const { data, error } = await supabase
    .from('stickers')
    .select(COLUMNS)
    .eq('scope', 'user')
    .eq('owner_id', profileId)
  if (error) throw error
  return ((data ?? []) as Sticker[]).sort(byName)
}

/** existing_sticker_ids takes at most this many ids per call. */
const EXISTING_BATCH = 500

/**
 * Of `ids`, those naming a stickers row, each with the row's url; ids that are not uuids are
 * left out. Answers whether or not the caller may read the row.
 */
export async function existingStickerIds(ids: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))].filter((id) => UUID.test(id))
  const found = new Map<string, string>()
  for (let i = 0; i < wanted.length; i += EXISTING_BATCH) {
    const { data, error } = await supabase.rpc('existing_sticker_ids', { p_ids: wanted.slice(i, i + EXISTING_BATCH) })
    if (error) throw error
    for (const row of (data ?? []) as Array<{ id: string; url: string }>) found.set(row.id, row.url)
  }
  return found
}

function fileProblemText(problem: StickerFileProblem, info: StickerImageInfo | null, size: number): string {
  switch (problem) {
    case 'type':
      return t('stickers.errors.type')
    case 'size':
      return t('stickers.errors.size', { size: formatBytes(size), max: formatBytes(STICKER_MAX_BYTES) })
    case 'dimensions':
      return t('stickers.errors.dimensions', {
        width: info?.width ?? 0,
        height: info?.height ?? 0,
        max: STICKER_MAX_SIDE,
      })
    case 'duration':
      return t('stickers.errors.duration', {
        seconds: ((info?.durationMs ?? 0) / 1000).toFixed(1),
        max: STICKER_MAX_DURATION_MS / 1000,
      })
  }
}

export function stickerTextProblemText(problem: StickerTextProblem): string {
  switch (problem) {
    case 'nameLength':
      return t('stickers.errors.nameLength', { min: STICKER_NAME_MIN, max: STICKER_NAME_MAX })
    case 'descriptionMissing':
      return t('stickers.errors.descriptionMissing')
    case 'descriptionLength':
      return t('stickers.errors.descriptionLength', { max: STICKER_DESCRIPTION_MAX })
  }
}

export interface PreparedSticker {
  prepared: PreparedImage
  info: StickerImageInfo
}

/**
 * A still image larger than the limits is redrawn within 320x320 and 512 KB; an animated one
 * is never redrawn and must already fit. Throws UploadRejectedError with a user-facing message.
 */
export async function prepareStickerImage(file: File): Promise<PreparedSticker> {
  const sourceError = imageSourceError(file)
  if (sourceError) throw new UploadRejectedError(sourceError)
  const limits = await getBucketLimits(STICKER_BUCKET)
  const prepared = await prepareImageUpload(file, 'sticker', {
    maxBytes: Math.min(limits.maxBytes || STICKER_MAX_BYTES, STICKER_MAX_BYTES),
    allowedMime: limits.allowedMime,
    maxSide: STICKER_MAX_SIDE,
  })
  const info = readStickerImageInfo(new Uint8Array(await prepared.file.arrayBuffer()))
  const problem = stickerFileProblem(info, prepared.file.size)
  if (problem || !info || !STICKER_EXTENSIONS.has(prepared.extension)) {
    throw new UploadRejectedError(fileProblemText(problem ?? 'type', info, prepared.file.size))
  }
  const bucketError = await validateImageUpload(prepared.file, STICKER_BUCKET)
  if (bucketError) throw new UploadRejectedError(bucketError)
  return { prepared, info }
}

export interface StickerUpload {
  scope: StickerScope
  /** The server of a server sticker. */
  serverId?: string | null
  /** The caller's profile id: the folder of a personal sticker. */
  profileId: string
  file: File
  name: string
  description: string
  onProgress?: (fraction: number) => void
}

function objectFolder(upload: StickerUpload): string {
  switch (upload.scope) {
    case 'server':
      return `server/${upload.serverId}`
    case 'instance':
      return 'instance'
    case 'user':
      return `user/${upload.profileId}`
  }
}

/**
 * Prepares, stores and records one sticker. A refused record removes the object and rethrows.
 * Throws UploadRejectedError for a file or text outside the limits.
 */
export async function uploadSticker(upload: StickerUpload): Promise<Sticker> {
  const textProblem = stickerTextProblem(upload.name, upload.description)
  if (textProblem) throw new UploadRejectedError(stickerTextProblemText(textProblem))
  if (upload.scope === 'server' && !upload.serverId) throw new Error('A server sticker names its server')

  const { prepared, info } = await prepareStickerImage(upload.file)
  const path = `${objectFolder(upload)}/${uuidv4()}.${prepared.extension}`
  const url = await storePublicImage(STICKER_BUCKET, path, prepared, {
    label: upload.file.name,
    onProgress: upload.onProgress,
  })
  const { data, error } = await supabase.rpc('create_sticker', {
    p_scope: upload.scope,
    p_server_id: upload.scope === 'server' ? upload.serverId : null,
    p_path: path,
    p_url: url,
    p_name: upload.name.trim(),
    p_description: upload.description.trim(),
    p_width: info.width,
    p_height: info.height,
    p_duration_ms: info.animated ? Math.max(1, info.durationMs ?? 1) : null,
  })
  if (error || !data) {
    await supabase.storage.from(STICKER_BUCKET).remove([path])
    throw error ?? new Error('create_sticker returned no row')
  }
  return data as Sticker
}

/** update_sticker: NULL keeps a field. */
export async function updateSticker(
  id: string,
  changes: { name?: string; description?: string },
): Promise<Sticker> {
  const textProblem = stickerTextProblem(changes.name ?? 'ok', changes.description ?? 'ok')
  if (textProblem) throw new UploadRejectedError(stickerTextProblemText(textProblem))
  const { data, error } = await supabase.rpc('update_sticker', {
    p_sticker_id: id,
    p_name: changes.name?.trim() ?? null,
    p_description: changes.description?.trim() ?? null,
  })
  if (error || !data) throw error ?? new Error('update_sticker returned no row')
  return data as Sticker
}

/**
 * delete_sticker, then the object it names. Parts that reference the sticker show a
 * placeholder once the row is gone; the object removal failing leaves the file reachable by
 * its URL, nothing more.
 */
export async function deleteSticker(id: string): Promise<void> {
  const { data: path, error } = await supabase.rpc('delete_sticker', { p_sticker_id: id })
  if (error) throw error
  if (typeof path === 'string' && path) {
    const { error: removeError } = await supabase.storage.from(STICKER_BUCKET).remove([path])
    if (removeError) debug.warn('Sticker file not removed:', path, removeError)
  }
}

/** User-facing text for a sticker upload, edit or removal failure. */
export function stickerErrorMessage(error: unknown): string {
  if (error instanceof UploadRejectedError) return error.message
  const e = error as { code?: string; message?: string } | null
  const message = e?.message ?? ''
  const limit = stickerLimitOf(error)
  if (limit !== null) return limit === 0 ? t('stickers.errors.off') : t('stickers.errors.limit', { max: limit })
  if (message.startsWith('STICKER_NAME_TAKEN')) return t('stickers.errors.nameTaken')
  if (message.startsWith('STICKER_NAME')) return stickerTextProblemText('nameLength')
  if (message.startsWith('STICKER_DESCRIPTION')) return stickerTextProblemText('descriptionMissing')
  if (message.startsWith('STICKER_FILE_SIZE')) return fileProblemText('size', null, STICKER_MAX_BYTES + 1)
  if (message.startsWith('STICKER_FILE_TYPE')) return fileProblemText('type', null, 0)
  if (message.startsWith('STICKER_DIMENSIONS')) return t('stickers.errors.dimensionsGeneric', { max: STICKER_MAX_SIDE })
  if (message.startsWith('STICKER_DURATION')) return t('stickers.errors.durationGeneric', { max: STICKER_MAX_DURATION_MS / 1000 })
  if (e?.code === '42501' || message.startsWith('STICKER_FORBIDDEN')) return t('stickers.errors.forbidden')
  if (e?.code === 'P0002') return t('stickers.errors.notFound')
  if ((error as { statusCode?: unknown })?.statusCode !== undefined) return humanizeUploadError(error, STICKER_BUCKET)
  return t('stickers.errors.generic')
}
