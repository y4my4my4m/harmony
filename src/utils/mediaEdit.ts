/**
 * Post media editing in the composer: crop aspect presets, the edit result
 * MediaEditDialog returns, and the attachment fields the composer keeps
 * between edits.
 */

import { rotatedSize, type CropState, type Rotation, type Size } from './cropGeometry'
import { clampFocus, isCentredFocus, type Focus } from './focalPoint'
import type { MediaAttachment } from '@/types'

export type MediaAspectKey = 'original' | 'square' | '16:9' | '4:3'

/** Width over height; null: the image's own aspect. */
export const MEDIA_ASPECTS: ReadonlyArray<{ key: MediaAspectKey; ratio: number | null }> = [
  { key: 'original', ratio: null },
  { key: 'square', ratio: 1 },
  { key: '16:9', ratio: 16 / 9 },
  { key: '4:3', ratio: 4 / 3 },
]

/** Smallest crop width of post media, source pixels. */
export const MEDIA_MIN_CROP_WIDTH = 64

export function mediaAspectRatio(key: MediaAspectKey, size: Size, rotation: Rotation): number {
  const ratio = MEDIA_ASPECTS.find((a) => a.key === key)?.ratio ?? null
  if (ratio !== null) return ratio
  const turned = rotatedSize(size, rotation)
  return turned.width / turned.height
}

export interface MediaCrop {
  state: CropState
  aspect: MediaAspectKey
}

/** MediaEditDialog result. `file` is present when the bytes to upload change. */
export interface MediaEdit {
  description: string
  focus: Focus | null
  file?: File
  /** The picked file, kept so a later edit starts from the uncropped image. */
  originalFile?: File
  crop?: MediaCrop | null
}

/** A composer attachment: the stored shape plus edit state that never leaves the client. */
export interface ComposerMediaAttachment extends MediaAttachment {
  focus?: Focus | null
  originalFile?: File
  crop?: MediaCrop | null
  /** Row from posts.media_attachments when editing a published post. */
  stored?: Record<string, unknown>
}

/** What MediaEditDialog reads from an attachment. */
export type EditableMedia = Pick<
  ComposerMediaAttachment,
  'type' | 'url' | 'preview_url' | 'description' | 'meta' | 'file' | 'originalFile' | 'crop' | 'focus'
>

/** A composer attachment already in storage: no File, an http(s) URL. */
export function isStoredMedia(value: unknown): value is { stored?: Record<string, unknown>; type?: string; url: string } {
  if (!value || typeof value !== 'object' || value instanceof File) return false
  const m = value as Record<string, unknown>
  return !(m.file instanceof File) && typeof m.url === 'string' && /^https?:\/\//i.test(m.url)
}

/**
 * A posts.media_attachments row with the composer's alt text and focus:
 * `description` when non-empty, `meta.focus` (Mastodon shape) when off-centre.
 */
export function withMediaEdits(
  row: Record<string, unknown>,
  description: string,
  focus: Focus | null,
): Record<string, unknown> {
  const { description: _description, meta, ...rest } = row
  const nextMeta: Record<string, unknown> = meta && typeof meta === 'object' ? { ...(meta as Record<string, unknown>) } : {}
  delete nextMeta.focus
  if (focus && !isCentredFocus(focus)) nextMeta.focus = clampFocus(focus)
  return {
    ...rest,
    ...(description ? { description } : {}),
    ...(Object.keys(nextMeta).length > 0 ? { meta: nextMeta } : {}),
  }
}
