import type { MessagePart } from '@/types';
import { extractHttpUrls } from '@/utils/urlSplitting';

const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp|bmp|svg|avif)(\?|$)/i;
const VIDEO_EXT = /\.(mp4|webm|ogg|avi|mov|wmv|flv|m4v)(\?|$)/i;

export type MediaGalleryPart = MessagePart & { type: 'media_gallery'; parts: MessagePart[] };

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
      const urls = extractHttpUrls(text);
      if (urls.length > 1 && urls.join('') === text.replace(/\s/g, '')) {
        for (const u of urls) {
          const fileType = inferFileTypeFromUrl(u);
          if (fileType === 'image' || fileType === 'video') {
            result.push({ type: 'file', url: u, fileType } as MessagePart);
          } else {
            result.push({ type: 'url', url: u, preview: true } as MessagePart);
          }
        }
        continue;
      }

      if (urls.length > 0) {
        let lastIndex = 0;
        let produced = false;
        GLUED_URL_SCAN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = GLUED_URL_SCAN.exec(text)) !== null) {
          const raw = match[0];
          const start = match.index;
          const { url: trimmed } = trimInlineUrl(raw);
          if (!trimmed) continue;

          if (start > lastIndex) {
            const before = text.slice(lastIndex, start);
            if (before) result.push({ type: 'text', text: before } as MessagePart);
          }

          const fileType = inferFileTypeFromUrl(trimmed);
          if (fileType === 'image' || fileType === 'video') {
            result.push({ type: 'file', url: trimmed, fileType } as MessagePart);
          } else {
            result.push({ type: 'url', url: trimmed, preview: true } as MessagePart);
          }

          lastIndex = start + raw.length;
          produced = true;
        }

        if (produced) {
          if (lastIndex < text.length) {
            const tail = text.slice(lastIndex);
            if (tail) result.push({ type: 'text', text: tail } as MessagePart);
          }
          continue;
        }
      }
    }

    result.push(part);
  }

  return result;
}

const GLUED_URL_SCAN = /https?:\/\/[^\s<>"']+?(?=https?:\/\/|\s|$|>)/g;

function trimInlineUrl(raw: string): { url: string } {
  let cleaned = raw;
  while (cleaned.length > 0 && /[.,;:!?)>\]}]$/.test(cleaned)) {
    cleaned = cleaned.slice(0, -1);
  }
  return { url: cleaned };
}

/**
 * Group consecutive image/video parts into a single `media_gallery` pseudo-part
 * for Discord-style mosaic rendering.
 */
export function groupMediaGalleryParts(parts: MessagePart[]): MessagePart[] {
  const normalized = splitGluedUrlsInParts(parts);
  const result: MessagePart[] = [];
  let i = 0;

  while (i < normalized.length) {
    const part = normalized[i];
    if (isViewableMediaPart(part)) {
      const group: MessagePart[] = [];
      while (i < normalized.length && isViewableMediaPart(normalized[i])) {
        group.push(normalized[i]);
        i++;
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

/** CSS class suffix for gallery layout (1–10 attachments). */
export function mediaGalleryLayoutClass(count: number): string {
  const n = Math.max(1, Math.min(count, 10));
  return `media-gallery-count-${n}`;
}
