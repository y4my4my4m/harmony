/**
 * Copying the profile of an account that moved here onto the account it moved to. Mastodon has no
 * equivalent. The values come from the stored row of the old account; nothing is fetched but the
 * two images.
 *
 * Images are stored again under the new account, as an upload would be: the old server may go away,
 * and a deleted account's objects are purged (account-deleted).
 */

import { randomUUID } from 'node:crypto';
import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';
import { sniffImage } from '../routes/adminEmojis.js';
import { stripMediaBytes } from '../utils/stripMetadata.js';
import { safeFetch } from '../utils/ssrfProtection.js';
import { logger } from '../utils/logger.js';

export const COPY_FIELDS = ['display_name', 'bio', 'avatar', 'banner', 'profile_fields'] as const;
export type CopyField = (typeof COPY_FIELDS)[number];

/** The client's limits (src/utils/uploadValidation.ts) when the bucket answers none. */
const IMAGE_BUCKETS = {
  avatar: { bucket: 'avatars', stem: 'avatar', column: 'avatar_url', defaultMaxBytes: 5 * 1024 * 1024 },
  banner: { bucket: 'banners', stem: 'banner', column: 'banner_url', defaultMaxBytes: 10 * 1024 * 1024 },
} as const;

/** profiles.avatar_url default: no avatar was chosen. */
const DEFAULT_AVATAR = '/default_avatar.webp';

/** src/utils/imageResize.ts IMMUTABLE_CACHE_SECONDS: object names are never reused. */
const IMMUTABLE_CACHE_SECONDS = '31536000';
const FETCH_TIMEOUT_MS = 15_000;
/** profiles.profile_fields value clamp (sanitize_profile_text). */
const FIELD_VALUE_MAX = 255;

export interface CopyOrigin {
  id: string;
  username: string;
  domain: string | null;
  federated_id: string | null;
  moved_to_id: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  profile_fields: unknown;
}

export interface ProfileCopy {
  update: Record<string, unknown>;
  copied: CopyField[];
  failed: CopyField[];
}

/** The fields a request names, known ones only, once each. */
export function parseCopyFields(raw: unknown): CopyField[] {
  if (!Array.isArray(raw)) return [];
  return COPY_FIELDS.filter((field) => raw.includes(field));
}

/**
 * Both sides of the move confirmed: the old account points here, and this account lists it.
 * carry_over_moved_membership requires the same.
 */
export function isVerifiedOrigin(origin: CopyOrigin | null | undefined, profileId: string, aliases: string[] | null): boolean {
  if (!origin || origin.moved_to_id !== profileId) return false;
  const uri = origin.federated_id || (origin.domain ? `https://${origin.domain}/users/${origin.username}` : null);
  return !!uri && (aliases ?? []).includes(uri);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Removes tags, and one the clamp left unterminated at the end. `a < b` is text. */
function stripTags(value: string): string {
  return value.replace(/<\/?[a-z!][^>]*(?:>|$)/gi, '');
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&#(\d+);/g, (m, dec) => {
      const cp = parseInt(dec, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&(lt|gt|quot|apos|nbsp);/g, (_m, name) => ({ lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[name])
    .replace(/&amp;/g, '&');
}

/**
 * A stored field value in the form the client writes (encodeFieldValueForStorage): a bare URL as a
 * single anchor, anything else as escaped text. A remote value is the actor's HTML cut at 255
 * characters, so its anchor may have lost the rest of its markup; the href survives first.
 */
export function copiedFieldValue(stored: unknown): string {
  const raw = String(stored ?? '');
  const href = /^\s*<a\s[^>]*?\bhref\s*=\s*["'](https?:\/\/[^"'\s<>]+)["']/i.exec(raw)?.[1];
  const text = href
    ? decodeEntities(href)
    : decodeEntities(stripTags(raw.replace(/<br\s*\/?>/gi, ' '))).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/^https?:\/\/[^\s<>]+$/i.test(text)) {
    const safe = escapeHtml(text);
    const anchor = `<a href="${safe}" target="_blank" rel="me nofollow noopener noreferrer">${safe}</a>`;
    // The clamp would cut the anchor.
    if (anchor.length <= FIELD_VALUE_MAX) return anchor;
  }
  return escapeHtml(text);
}

/** Rows with both a name and a value, at most four as the profile holds. */
export function copiedProfileFields(stored: unknown): Array<{ name: string; value: string }> {
  if (!Array.isArray(stored)) return [];
  return stored
    .map((field: any) => ({
      name: decodeEntities(stripTags(String(field?.name ?? ''))).trim(),
      value: copiedFieldValue(field?.value),
    }))
    .filter((field) => field.name && field.value)
    .slice(0, 4);
}

/** Object path of `source` when it is an object of this instance's `bucket`. */
function localObjectPath(source: string, bucket: string): string | null {
  if (!/^https?:\/\//i.test(source)) return source.replace(/^\/+/, '') || null;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  const hosts = [config.INSTANCE_DOMAIN, config.SUPABASE_URL, config.PUBLIC_SUPABASE_URL]
    .filter((value): value is string => !!value)
    .map((value) => (/^https?:\/\//i.test(value) ? new URL(value).host : value).toLowerCase());
  if (!hosts.includes(url.host.toLowerCase())) return null;
  const prefix = `/storage/v1/object/public/${bucket}/`;
  return url.pathname.startsWith(prefix) ? decodeURIComponent(url.pathname.slice(prefix.length)) : null;
}

async function imageBytes(source: string, bucket: string, maxBytes: number): Promise<Uint8Array | null> {
  const path = localObjectPath(source, bucket);
  if (path) {
    const { data, error } = await getSupabaseClient().storage.from(bucket).download(path);
    if (error || !data) {
      logger.warn(`Profile copy: reading ${bucket}/${path} failed: ${error?.message}`);
      return null;
    }
    return new Uint8Array(await data.arrayBuffer());
  }
  const response = await safeFetch(source, {
    headers: { Accept: 'image/png, image/gif, image/webp, image/jpeg;q=0.9, */*;q=0.1' },
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBodyBytes: maxBytes,
  });
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* drained */ }
    logger.warn(`Profile copy: ${source} answered ${response.status}`);
    return null;
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** The image stored under `folder`; its object path, null when it cannot be read or is no image. */
async function copyImage(source: string, kind: keyof typeof IMAGE_BUCKETS, folder: string): Promise<string | null> {
  const { bucket, stem, defaultMaxBytes } = IMAGE_BUCKETS[kind];
  const storage = getSupabaseClient().storage;
  try {
    const { data: limits } = await storage.getBucket(bucket);
    const bucketMax = Number(limits?.file_size_limit);
    const maxBytes = Number.isFinite(bucketMax) && bucketMax > 0 ? bucketMax : defaultMaxBytes;
    const bytes = await imageBytes(source, bucket, maxBytes);
    if (!bytes || bytes.length > maxBytes) return null;
    const image = sniffImage(bytes);
    if (!image) return null;

    const path = `${folder}/${stem}-${Date.now()}-${randomUUID().slice(0, 8)}.${image.ext}`;
    const clean = Buffer.from(await stripMediaBytes(bytes));
    const { error } = await storage.from(bucket).upload(path, clean, {
      contentType: image.contentType,
      cacheControl: IMMUTABLE_CACHE_SECONDS,
      upsert: false,
    });
    if (error) {
      logger.error(`Profile copy: storing ${bucket}/${path} failed: ${error.message}`);
      return null;
    }
    return path;
  } catch (err) {
    logger.warn(`Profile copy: ${kind} from ${source} failed: ${(err as Error)?.message}`);
    return null;
  }
}

/**
 * The column values of the requested fields. A field empty on the old account is neither copied
 * nor failed: a copy never blanks what the new account has.
 */
export async function buildProfileCopy(origin: CopyOrigin, fields: CopyField[], folder: string): Promise<ProfileCopy> {
  const copy: ProfileCopy = { update: {}, copied: [], failed: [] };
  for (const field of fields) {
    if (field === 'avatar' || field === 'banner') {
      const { column } = IMAGE_BUCKETS[field];
      const source = origin[column];
      if (!source || source === DEFAULT_AVATAR) continue;
      const path = await copyImage(source, field, folder);
      if (path) {
        copy.update[column] = path;
        copy.copied.push(field);
      } else {
        copy.failed.push(field);
      }
    } else if (field === 'profile_fields') {
      const rows = copiedProfileFields(origin.profile_fields);
      if (rows.length === 0) continue;
      copy.update.profile_fields = rows;
      copy.copied.push(field);
    } else {
      const value = origin[field];
      if (typeof value !== 'string' || !value.trim()) continue;
      copy.update[field] = value;
      copy.copied.push(field);
    }
  }
  return copy;
}

/** Removes the objects a copy stored. */
export async function removeCopiedImages(update: Record<string, unknown>): Promise<void> {
  const storage = getSupabaseClient().storage;
  for (const kind of ['avatar', 'banner'] as const) {
    const { bucket, column } = IMAGE_BUCKETS[kind];
    const path = update[column];
    if (typeof path !== 'string') continue;
    const { error } = await storage.from(bucket).remove([path]);
    if (error) logger.warn(`Profile copy: removing ${bucket}/${path} failed: ${error.message}`);
  }
}
