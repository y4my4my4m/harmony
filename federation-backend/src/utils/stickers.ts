/**
 * Sticker message parts over federation.
 *
 * A sticker is {type:'sticker', id, url, name, description, width?, height?, mimeType?, domain?}
 * followed by an image {type:'file', stickerId, url, altText, ...}. Channel messages carry both
 * in harmony:rawContent; Harmony before 1.9.2 renders the image and ignores the sticker, and
 * the image is also the Note's Document attachment, named by the description. DMs carry no
 * rawContent: their Note names the sticker in harmony:sticker beside the attachment.
 *
 * Inbound limits mirror check_message_sticker_parts (20261031200001_custom_stickers.sql): one
 * sticker per message; id 1-200 characters, http(s) url up to 2048 with its scheme lower-cased,
 * name 1-30 and description 1-300 characters after trimming. `domain` names the sticker's
 * instance; absent means this one. A fallback is an image at the sticker's url; any other file
 * part naming the sticker loses `stickerId` and renders as itself.
 */
import config from '../config/index.js';

const NAME_MAX = 30;
const DESCRIPTION_MAX = 300;
const URL_MAX = 2048;
const ID_MAX = 200;
const SIDE_MAX = 4096;
const HOSTNAME = /^[a-z0-9.-]+(:[0-9]{1,5})?$/i;

export interface StickerPart {
  type: 'sticker';
  id: string;
  url: string;
  name: string;
  description: string;
  width?: number;
  height?: number;
  mimeType?: string;
  domain?: string;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cut(text: string, max: number): string {
  return [...text.trim()].slice(0, max).join('').trim();
}

/** `url` with its http(s) scheme lower-cased; the trigger's url equality is case-sensitive. */
function lowerScheme(url: string): string {
  return url.replace(/^https?:/i, (scheme) => scheme.toLowerCase());
}

function side(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= SIDE_MAX ? value : undefined;
}

/** A well-formed sticker part from untrusted input, or null. */
export function sanitizeSticker(raw: unknown, senderHost: string | null): StickerPart | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const url = typeof raw.url === 'string' ? lowerScheme(raw.url.trim()) : '';
  const name = typeof raw.name === 'string' ? cut(raw.name, NAME_MAX) : '';
  const description = typeof raw.description === 'string' ? cut(raw.description, DESCRIPTION_MAX) : '';
  if (!id || id.length > ID_MAX || !/^https?:\/\//i.test(url) || url.length > URL_MAX || !name || !description) {
    return null;
  }
  const claimed = typeof raw.domain === 'string' && HOSTNAME.test(raw.domain) ? raw.domain.toLowerCase() : null;
  const ours = config.INSTANCE_DOMAIN.toLowerCase();
  const sender = senderHost?.toLowerCase() ?? null;
  // Another host cannot make a sticker local: a claim of this domain from elsewhere stays theirs.
  const domain = sender && sender !== ours && claimed === ours ? sender : claimed ?? sender;
  const width = side(raw.width);
  const height = side(raw.height);
  const mimeType = typeof raw.mimeType === 'string' && /^image\/[a-z0-9.+-]+$/i.test(raw.mimeType)
    ? raw.mimeType.toLowerCase()
    : typeof raw.mediaType === 'string' && /^image\/[a-z0-9.+-]+$/i.test(raw.mediaType)
    ? raw.mediaType.toLowerCase()
    : undefined;
  return {
    type: 'sticker',
    id,
    url,
    name,
    description,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(mimeType ? { mimeType } : {}),
    // A sticker of this instance, echoed back by a host, is looked up here again.
    ...(domain && domain !== ours ? { domain } : {}),
  };
}

function isStickerPart(part: unknown): boolean {
  return isRecord(part) && part.type === 'sticker';
}

/** A file part that may stand in for `sticker`: an image at its url, scheme case aside. */
function fitsSticker(part: unknown, sticker: StickerPart): boolean {
  return isRecord(part) && part.type === 'file' && part.fileType === 'image'
    && typeof part.url === 'string' && lowerScheme(part.url.trim()) === sticker.url;
}

/**
 * Incoming rawContent: the first well-formed sticker part kept, with its `domain`; any other
 * sticker part dropped, and the image fallbacks of dropped stickers left as plain images.
 */
export function normalizeInboundStickers(content: any[], senderHost: string | null): any[] {
  if (!Array.isArray(content) || !content.some(isStickerPart)) return content;
  let kept: StickerPart | null = null;
  const out: any[] = [];
  for (const part of content) {
    if (!isStickerPart(part)) {
      out.push(part);
      continue;
    }
    const sticker: StickerPart | null = kept ? null : sanitizeSticker(part, senderHost);
    if (sticker) {
      kept = sticker;
      out.push(sticker);
    }
  }
  return out.map((part) => {
    if (!isRecord(part) || part.type !== 'file' || typeof part.stickerId !== 'string') return part;
    if (kept && part.stickerId === kept.id && fitsSticker(part, kept)) return { ...part, url: kept.url };
    const { stickerId: _stickerId, ...rest } = part;
    return rest;
  });
}

/** The message's sticker part, or null. */
export function messageSticker(content: unknown): Record<string, any> | null {
  if (!Array.isArray(content)) return null;
  return (content.find(isStickerPart) as Record<string, any> | undefined) ?? null;
}

/** harmony:sticker of an outbound DM Note: the sticker of the message, or undefined. */
export function stickerNoteExtension(content: unknown): Record<string, unknown> | undefined {
  const sticker = messageSticker(content);
  if (!sticker || typeof sticker.url !== 'string' || !/^https?:\/\//i.test(sticker.url)) return undefined;
  return {
    id: sticker.id,
    url: sticker.url,
    name: sticker.name,
    description: sticker.description,
    ...(side(sticker.width) ? { width: sticker.width } : {}),
    ...(side(sticker.height) ? { height: sticker.height } : {}),
    ...(typeof sticker.mimeType === 'string' ? { mediaType: sticker.mimeType } : {}),
    ...(typeof sticker.domain === 'string' ? { domain: sticker.domain } : {}),
  };
}

/**
 * Inbound DM content from a Note's HTML and attachments, with the sticker its harmony:sticker
 * names: the image attachment at the same url becomes the sticker's fallback, and the sticker
 * part goes before it. Content without a matching attachment is returned as it is.
 */
export function withInboundSticker(content: any[], extension: unknown, senderHost: string | null): any[] {
  if (!Array.isArray(content) || content.some(isStickerPart)) return content;
  const sticker = sanitizeSticker(extension, senderHost);
  if (!sticker) return content;
  const at = content.findIndex((part) => fitsSticker(part, sticker));
  if (at < 0) return content;
  const fallback = { ...content[at], url: sticker.url, stickerId: sticker.id };
  return [...content.slice(0, at), sticker, fallback, ...content.slice(at + 1)];
}
