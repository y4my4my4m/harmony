/**
 * Sticker message parts. A sticker is sent as a StickerContent followed by a FileContent
 * image with the same url and `stickerId`; clients before 1.9.2, previews that count files,
 * and other ActivityPub software read the image, while this client renders the sticker and
 * hides the image.
 */
import type { FileContent, MessagePart, StickerContent } from '@/types'

/** The fields of a stickers row a message part carries. */
export interface StickerPartSource {
  id: string
  url: string
  name: string
  description: string
  width?: number | null
  height?: number | null
  mime_type?: string | null
}

export function isStickerPart(part: unknown): part is StickerContent {
  return !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'sticker'
}

/** The message's sticker, or null. */
export function messageSticker(parts: readonly MessagePart[] | null | undefined): StickerContent | null {
  if (!Array.isArray(parts)) return null
  return (parts.find(isStickerPart) as StickerContent | undefined) ?? null
}

/** [sticker, image fallback] for one sticker. */
export function stickerMessageParts(sticker: StickerPartSource): [StickerContent, FileContent] {
  const size = {
    ...(sticker.width ? { width: sticker.width } : {}),
    ...(sticker.height ? { height: sticker.height } : {}),
  }
  const mime = sticker.mime_type ? { mimeType: sticker.mime_type } : {}
  return [
    {
      type: 'sticker',
      id: sticker.id,
      url: sticker.url,
      name: sticker.name,
      description: sticker.description,
      ...size,
      ...mime,
    },
    {
      type: 'file',
      fileType: 'image',
      url: sticker.url,
      fileName: sticker.name,
      altText: sticker.description,
      stickerId: sticker.id,
      ...size,
      ...mime,
    },
  ]
}

/**
 * A file part standing in for a sticker part of the same message: an image at the sticker's
 * url naming it. Any other file part renders, so no image hides behind a sticker.
 */
export function isStickerFallback(part: unknown, parts: readonly MessagePart[]): boolean {
  if (!part || typeof part !== 'object') return false
  const file = part as Partial<FileContent>
  if (file.type !== 'file' || file.fileType !== 'image' || typeof file.stickerId !== 'string') return false
  return parts.some((p) => isStickerPart(p) && p.id === file.stickerId && p.url === file.url)
}

/**
 * The parts without image fallbacks of stickers present in the message. A fallback whose
 * sticker part is gone (an older client's edit dropped it) stays and renders as an image.
 */
export function withoutStickerFallbacks<T extends MessagePart>(parts: readonly T[]): T[] {
  if (!Array.isArray(parts) || !parts.some(isStickerPart)) return parts as T[]
  return parts.filter((p) => !isStickerFallback(p, parts))
}
