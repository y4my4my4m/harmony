/**
 * Chat attachments in the private message_media bucket, over federation.
 *
 * A file part names its object in `path` (`c/<channel id>/...` or `d/<conversation id>/...`).
 * Content leaving this instance carries a capability URL instead:
 *
 *   https://<INSTANCE_DOMAIN>/api/federation/media/<path>?to=<audience>&sig=<hmac>
 *
 * The audience is the receiving instance's domain, or `*` for content the Group outbox
 * serves to anyone. sig is HMAC-SHA256 over "v1\n<path>\n<audience>", base64url. The
 * media route checks the signature, then public.federation_media_access(path, audience):
 * the URL works while that instance still receives the room, and redirects to a storage
 * URL signed for REDIRECT_TTL_SECONDS.
 *
 * Remote fetchers are not asked for HTTP signatures. Mastodon, Misskey and Akkoma
 * download attachments unsigned, Misskey without its file cache proxies the URL on
 * every view, and a remote Harmony renders the URL in its users' browsers.
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import config from '../config/index.js';

export const MESSAGE_MEDIA_BUCKET = 'message_media';
/** Lifetime of the storage URL the media route redirects to. */
export const REDIRECT_TTL_SECONDS = 300;
/** Audience of content served to unsigned readers of a public server. */
export const PUBLIC_AUDIENCE = '*';

const PATH_PATTERN = /^[cd]\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^?#\\]+$/i;
const AUDIENCE_PATTERN = /^(\*|[a-z0-9.-]+(?::\d{1,5})?)$/;

/** An object name of message_media: a room prefix, no query, no dot segments. */
export function isPrivateMediaPath(path: unknown): path is string {
  return typeof path === 'string'
    && PATH_PATTERN.test(path)
    && !path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

export function normalizeAudience(audience: string): string | null {
  const value = audience.trim().toLowerCase();
  return AUDIENCE_PATTERN.test(value) ? value : null;
}

function signingKey(): string {
  if (config.MEDIA_URL_SECRET) return config.MEDIA_URL_SECRET;
  return createHash('sha256')
    .update(`federation-media-url:${config.SUPABASE_SERVICE_ROLE_KEY}`)
    .digest('hex');
}

export function mediaUrlSignature(path: string, audience: string): string {
  return createHmac('sha256', signingKey()).update(`v1\n${path}\n${audience}`).digest('base64url');
}

export function verifyMediaUrlSignature(path: string, audience: string, signature: unknown): boolean {
  if (typeof signature !== 'string' || !signature) return false;
  const expected = Buffer.from(mediaUrlSignature(path, audience));
  const provided = Buffer.from(signature);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function mediaBaseUrl(): string {
  return (config.MEDIA_PUBLIC_BASE_URL || `https://${config.INSTANCE_DOMAIN}/api/federation`).replace(/\/+$/, '');
}

/** Capability URL of an object for one audience. */
export function federatedMediaUrl(path: string, audience: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const query = new URLSearchParams({ to: audience, sig: mediaUrlSignature(path, audience) });
  return `${mediaBaseUrl()}/media/${encodedPath}?${query.toString()}`;
}

function isFilePart(part: unknown): part is Record<string, any> {
  return !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'file';
}

/**
 * Content for an audience: each file part with a path carries the audience's capability
 * URL and no path. Other parts are returned as they are.
 */
export function federateContentParts<T>(content: T, audience: string): T {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!isFilePart(part) || !('path' in part)) return part;
    const { path, ...rest } = part;
    return isPrivateMediaPath(path) ? { ...rest, url: federatedMediaUrl(path, audience) } : rest;
  }) as T;
}

/**
 * Content received over federation: file parts lose `path`. A path names an object of
 * this instance's bucket, which a remote sender has no business naming.
 */
export function stripIncomingMediaPaths<T>(content: T): T {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!isFilePart(part) || !('path' in part)) return part;
    const { path: _path, ...rest } = part;
    return rest;
  }) as T;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav', opus: 'audio/opus',
  pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip',
};

function mediaTypeOf(part: Record<string, any>, url: string): string {
  if (typeof part.mimeType === 'string' && part.mimeType.includes('/')) return part.mimeType;
  const source = typeof part.path === 'string' ? part.path : url.split(/[?#]/)[0];
  const ext = source.split('.').pop()?.toLowerCase() || '';
  // Voice messages are webm or ogg containers holding audio only.
  if (part.fileType === 'audio' && (ext === 'webm' || ext === 'ogg')) return `audio/${ext}`;
  if (MIME_BY_EXTENSION[ext]) return MIME_BY_EXTENSION[ext];
  switch (part.fileType) {
    case 'image': return 'image/*';
    case 'video': return 'video/*';
    case 'audio': return 'audio/*';
    default: return 'application/octet-stream';
  }
}

/** ActivityPub attachments for the file parts of message content, for one audience. */
export function fileAttachmentsToAp(content: unknown, audience: string): any[] {
  if (!Array.isArray(content)) return [];
  const out: any[] = [];
  for (const part of content) {
    if (!isFilePart(part)) continue;
    const url = isPrivateMediaPath(part.path)
      ? federatedMediaUrl(part.path, audience)
      : (typeof part.url === 'string' && /^https?:\/\//i.test(part.url) ? part.url : null);
    if (!url) continue;
    out.push({
      type: 'Document',
      mediaType: mediaTypeOf(part, url),
      url,
      name: typeof part.fileName === 'string' ? part.fileName : null,
    });
  }
  return out;
}
