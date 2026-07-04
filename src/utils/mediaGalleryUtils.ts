import type { MessagePart } from '@/types';
import { extractHttpUrls, isPureGluedUrlBlob } from '@/utils/urlSplitting';

const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp|bmp|svg|avif)(\?|$)/i;
const VIDEO_EXT = /\.(mp4|webm|ogg|avi|mov|wmv|flv|m4v)(\?|$)/i;

export type MediaGalleryPart = { type: 'media_gallery'; parts: MessagePart[] };

/** A display-content entry: either a raw message part or a grouped media gallery. */
export type DisplayPart = MessagePart | MediaGalleryPart;

export function isImageMediaUrl(url: string): boolean {
  return !!url && IMAGE_EXT.test(url);
}

export function isVideoMediaUrl(url: string): boolean {
  return !!url && VIDEO_EXT.test(url);
}

function inferFileTypeFromUrl(url: string): 'image' | 'video' | 'file' {
  if (isImageMediaUrl(url)) return 'image';
  if (isVideoMediaUrl(url)) return 'video';
  return 'file';
}

/** Whether a message part should participate in an inline media mosaic. */
export function isViewableMediaPart(part: MessagePart): boolean {
  if (!part || typeof part !== 'object') return false;

  if (part.type === 'file') {
    const ft = (part as { fileType?: string }).fileType;
    if (ft === 'image' || ft === 'video') return true;
    const url = (part as { url?: string }).url || '';
    return isImageMediaUrl(url) || isVideoMediaUrl(url);
  }

  if (part.type === 'url') {
    const url = (part as { url?: string }).url || '';
    return isImageMediaUrl(url) || isVideoMediaUrl(url);
  }

  return false;
}

/**
 * Split glued URLs inside text/url parts so each attachment becomes its own part.
 */
export function splitGluedUrlsInParts(parts: MessagePart[]): MessagePart[] {
  if (!Array.isArray(parts)) return [];

  const result: MessagePart[] = [];

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;

    if (part.type === 'url') {
      const url = (part as { url?: string }).url || '';
      const split = extractHttpUrls(url);
      if (split.length > 1) {
        for (const u of split) {
          result.push({
            type: 'url',
            url: u,
            preview: (part as { preview?: boolean }).preview,
          } as MessagePart);
        }
        continue;
      }
    }

    if (part.type === 'text') {
      const text = (part as { text?: string }).text || '';
      // Only repair bridge-style glued attachment blobs. Prose (including
      // Discord-style `<https://...>`) is left alone - that syntax is handled
      // at compose time by parseTextForUrls + parseUrlMatchContext.
      if (isPureGluedUrlBlob(text)) {
        for (const u of extractHttpUrls(text)) {
          const fileType = inferFileTypeFromUrl(u);
          if (fileType === 'image' || fileType === 'video') {
            result.push({ type: 'file', url: u, fileType } as MessagePart);
          } else {
            result.push({ type: 'url', url: u, preview: true } as MessagePart);
          }
        }
        continue;
      }
    }

    result.push(part);
  }

  return result;
}

/**
 * Group consecutive image/video parts into a single `media_gallery` pseudo-part
 * for Discord-style mosaic rendering.
 */
export function groupMediaGalleryParts(parts: MessagePart[]): DisplayPart[] {
  const normalized = splitGluedUrlsInParts(parts);
  const result: DisplayPart[] = [];
  let i = 0;

  while (i < normalized.length) {
    const part = normalized[i];
    if (isViewableMediaPart(part)) {
      const group: MessagePart[] = [];
      while (i < normalized.length) {
        if (isViewableMediaPart(normalized[i])) {
          group.push(normalized[i]);
          i++;
        } else if (
          isWhitespaceOnlyTextPart(normalized[i]) &&
          i + 1 < normalized.length &&
          isViewableMediaPart(normalized[i + 1])
        ) {
          i++;
        } else {
          break;
        }
      }
      if (group.length === 1) {
        result.push(group[0]);
      } else {
        result.push({ type: 'media_gallery', parts: group } as MediaGalleryPart);
      }
    } else {
      result.push(part);
      i++;
    }
  }

  return result;
}

/** CSS class for gallery layout (1–10 attachments). Must match MessageMediaGallery.vue selectors. */
export function mediaGalleryLayoutClass(count: number): string {
  const n = Math.max(1, Math.min(count, 10));
  return `message-media-gallery-count-${n}`;
}

function isWhitespaceOnlyTextPart(part: MessagePart): boolean {
  return (
    !!part &&
    typeof part === 'object' &&
    part.type === 'text' &&
    !String((part as { text?: string }).text || '').trim()
  );
}
