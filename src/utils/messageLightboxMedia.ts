// The media of one chat message, in display order, as the media viewer's items: images and
// videos of file parts, of linked media files, of grouped galleries, and the GIF or clip an
// embed resolves to. Stickers, AI emoji, gone files and covered spoilers never open.

import type { LightboxMedia } from '@/composables/useLightbox'
import type { MessagePart } from '@/types'
import { isImageMediaUrl, isVideoMediaUrl, type DisplayPart } from '@/utils/mediaGalleryUtils'
import { stripKlipyAttributionFragment } from '@/utils/klipyAttribution'

export interface ChatMediaPart {
  type?: string
  url?: string
  path?: string
  fileType?: string
  fileName?: string
  altText?: unknown
  preview?: unknown
}

export interface ChatLightboxEntry {
  /** What an opener names the item by: the part's object name when private, else its URL. */
  key: string
  media: LightboxMedia
  /** The file or url part the item came from; absent for embed media. */
  part?: ChatMediaPart
}

export interface ChatLightboxHelpers {
  /** Original-size source of a file or url part; undefined while a private part is unsigned. */
  source: (part: ChatMediaPart) => string | undefined
  /** Text alternative of an image part. */
  imageAlt: (part: ChatMediaPart) => string
  /** Text alternative of a video part. */
  videoAlt: (part: ChatMediaPart) => string
  /** Parts that never open the viewer. */
  excluded: (part: ChatMediaPart) => boolean
  /** Media an embed or link part resolves to. */
  embedMedia: (part: MessagePart) => { kind: 'image' | 'video' | 'clip'; url: string } | null
  /** Text alternative of an embed's GIF. */
  gifAlt: string
}

/** Opener key of a file or url part. */
export function chatMediaKey(part: ChatMediaPart): string {
  return part.path || stripKlipyAttributionFragment(part.url || '')
}

function showsPreview(part: ChatMediaPart): boolean {
  return part.preview !== false && part.preview !== 'false'
}

function mediaKind(part: ChatMediaPart): 'image' | 'video' | null {
  const url = stripKlipyAttributionFragment(part.url || '')
  if (part.type === 'file') {
    if (part.fileType === 'image' || part.fileType === 'video') return part.fileType
    if (part.fileType === 'audio') return null
  } else if (part.type !== 'url' || !showsPreview(part)) {
    return null
  }
  if (isImageMediaUrl(url)) return 'image'
  if (isVideoMediaUrl(url)) return 'video'
  return null
}

function fromPart(part: ChatMediaPart, helpers: ChatLightboxHelpers): ChatLightboxEntry | null {
  const kind = mediaKind(part)
  if (!kind || helpers.excluded(part)) return null
  const url = helpers.source(part) || stripKlipyAttributionFragment(part.url || '')
  if (!url) return null
  const media: LightboxMedia =
    kind === 'image'
      ? { url, type: 'image', alt: helpers.imageAlt(part) }
      : { url, type: 'video', alt: helpers.videoAlt(part) || undefined }
  if (part.fileName) media.name = part.fileName
  return { key: chatMediaKey(part), media, part }
}

/** The viewer's items for a message's display parts (UnifiedMessageContent displayContent). */
export function chatLightboxEntries(parts: readonly DisplayPart[], helpers: ChatLightboxHelpers): ChatLightboxEntry[] {
  const entries: ChatLightboxEntry[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'media_gallery') {
      for (const inner of (part as { parts: MessagePart[] }).parts) {
        const entry = fromPart(inner as ChatMediaPart, helpers)
        if (entry) entries.push(entry)
      }
      continue
    }
    const direct = fromPart(part as ChatMediaPart, helpers)
    if (direct) {
      entries.push(direct)
      continue
    }
    if (part.type !== 'url') continue
    const embed = helpers.embedMedia(part as MessagePart)
    if (!embed) continue
    if (embed.kind === 'image') entries.push({ key: embed.url, media: { url: embed.url, type: 'image', alt: helpers.gifAlt } })
    else entries.push({ key: embed.url, media: { url: embed.url, type: 'video', loop: embed.kind === 'video' } })
  }
  return entries
}
