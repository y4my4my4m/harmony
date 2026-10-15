import { supabase } from '@/supabase'
import { mediaPartSource } from '@/services/privateMedia'
import { publicImageUrl } from '@/utils/storageImageUtils'
import type { DriveFile, DriveFileKind } from '@/services/drive/driveService'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** 1536 -> "1.5 KB"; binary multiples, one decimal under 10. */
export function formatBytes(bytes: number, locale?: string): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  const digits = i === 0 || value >= 10 ? 0 : 1
  return `${value.toLocaleString(locale, { maximumFractionDigits: digits })} ${UNITS[i]}`
}

export function kindIcon(kind: DriveFileKind, mime?: string | null): string {
  if (kind === 'image') return 'file-image'
  if (kind === 'video') return 'file-video'
  if (kind === 'audio') return 'file-audio'
  if (kind === 'document') return 'file'
  if (mime && /zip|rar|7z|tar|gzip/.test(mime)) return 'file-archive'
  return 'file'
}

/** Whole days until `iso`, at least 0. */
export function daysUntil(iso: string | null): number {
  if (!iso) return 0
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000))
}

/** Extension of the object, upper case, for file tiles without a preview. */
export function extensionLabel(file: Pick<DriveFile, 'name' | 'path'>): string {
  const source = file.name || file.path
  const ext = source.includes('.') ? source.split('.').pop() ?? '' : ''
  return /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toUpperCase() : 'FILE'
}

/** Thumbnail or poster source of a file, when one can be shown; reactive for private objects. */
export function driveThumbnail(file: DriveFile): string | undefined {
  if (file.kind !== 'image' || file.state === 'gone') return undefined
  if (file.bucket === 'user_media') {
    return publicImageUrl('user_media', file.path, { width: 480, height: 480, resize: 'cover', quality: 75 })
  }
  return mediaPartSource({ path: file.path }, 'thumbnail')
}

/** Playable source of a video or audio file; reactive for private objects. */
export function driveMediaSource(file: DriveFile): string | undefined {
  if (file.state === 'gone') return undefined
  if (file.bucket === 'user_media') return supabase.storage.from('user_media').getPublicUrl(file.path).data.publicUrl
  return mediaPartSource({ path: file.path })
}
