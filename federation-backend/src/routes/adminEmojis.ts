/**
 * Instance emoji copied onto this instance (migration 20261107100001_emoji_lifecycle.sql).
 *
 *   POST /import      { remoteEmojiId, name? }  a remote_emojis_cache row becomes an instance emoji
 *   POST /:id/rehost                            an instance emoji pointing off-instance moves here
 *
 * Mounted at /admin/emojis and /api/federation/admin/emojis. Instance admins only
 * (utils/instanceAdmin.ts). The image is fetched with safeFetch, identified by its magic bytes
 * (png, apng, gif, webp, jpeg), held to the emojis bucket's file_size_limit, stripped of
 * metadata and stored at 00000000-0000-0000-0000-000000000000/<uuid>.<ext>; import_remote_emoji
 * or rehost_emoji then records its public URL. A refused record removes the object.
 * Errors answer { error: <code> }.
 */

import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';
import { createStrictKeyedLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireInstanceAdmin, type InstanceAdmin } from '../utils/instanceAdmin.js';
import { safeFetch } from '../utils/ssrfProtection.js';
import { stripMediaBytes } from '../utils/stripMetadata.js';
import { logger } from '../utils/logger.js';

const router = Router();

const writeLimit = createStrictKeyedLimit({
  name: 'admin-emojis',
  windowMs: 60 * 60 * 1000,
  maxRequests: 300,
  message: 'Too many emoji imports; try again later.',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** create_instance_emoji's folder; import_remote_emoji and rehost_emoji take the same path rule. */
export const INSTANCE_EMOJI_FOLDER = '00000000-0000-0000-0000-000000000000';

/** Mirrors the import_remote_emoji and rename_emoji name check. */
const EMOJI_NAME = /^[A-Za-z0-9_-]{2,64}$/;

const BUCKET = 'emojis';

/** The client's emojis limit (src/utils/uploadValidation.ts) when the bucket answers none. */
const DEFAULT_MAX_BYTES = 1024 * 1024;
const BUCKET_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface SniffedImage {
  ext: 'png' | 'apng' | 'gif' | 'webp' | 'jpg';
  /** An animated PNG keeps image/png and is named .apng, as client uploads are (utils/imageResize.ts). */
  contentType: string;
}

/** PNG chunks from offset 8 up to the first IDAT: acTL there marks an animated PNG. */
function pngIsAnimated(b: Uint8Array): boolean {
  let o = 8;
  while (o + 8 <= b.length) {
    const length = ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    o += 12 + length;
  }
  return false;
}

/** Image type by magic bytes; null for anything else. The remote Content-Type is not trusted. */
export function sniffImage(b: Uint8Array): SniffedImage | null {
  const at = (offset: number, text: string) =>
    b.length >= offset + text.length && [...text].every((c, i) => b[offset + i] === c.charCodeAt(0));
  if (b.length >= 8 && b[0] === 0x89 && at(1, 'PNG\r\n\x1a\n')) {
    return pngIsAnimated(b) ? { ext: 'apng', contentType: 'image/png' } : { ext: 'png', contentType: 'image/png' };
  }
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return { ext: 'gif', contentType: 'image/gif' };
  if (at(0, 'RIFF') && at(8, 'WEBP')) return { ext: 'webp', contentType: 'image/webp' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', contentType: 'image/jpeg' };
  return null;
}

let bucketCache: { at: number; maxBytes: number; mime: string[] | null } | null = null;

async function bucketLimits(): Promise<{ maxBytes: number; mime: string[] | null }> {
  if (bucketCache && Date.now() - bucketCache.at < BUCKET_TTL_MS) return bucketCache;
  let maxBytes = DEFAULT_MAX_BYTES;
  let mime: string[] | null = null;
  try {
    const { data } = await getSupabaseClient().storage.getBucket(BUCKET);
    const limit = Number(data?.file_size_limit);
    if (Number.isFinite(limit) && limit > 0) maxBytes = limit;
    if (Array.isArray(data?.allowed_mime_types) && data.allowed_mime_types.length > 0) mime = data.allowed_mime_types;
  } catch (error) {
    logger.warn('Admin emojis: reading the emojis bucket failed:', error);
  }
  bucketCache = { at: Date.now(), maxBytes, mime };
  return bucketCache;
}

/** Test hook: the next request reads the bucket again. */
export function resetBucketLimits(): void {
  bucketCache = null;
}

class Refusal extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

/** The image at `url`, stored in the instance folder; its object path and public URL. */
async function copyImage(url: string): Promise<{ path: string; publicUrl: string }> {
  const { maxBytes, mime } = await bucketLimits();
  let bytes: Uint8Array;
  try {
    const response = await safeFetch(url, {
      headers: { Accept: 'image/png, image/apng, image/gif, image/webp, image/jpeg;q=0.9, */*;q=0.1' },
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBodyBytes: maxBytes,
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* drained */ }
      throw new Refusal(502, 'fetch_failed');
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (/body (too large|exceeded)/.test(String((error as Error)?.message))) throw new Refusal(413, 'too_large');
    logger.warn(`Admin emojis: fetching ${url} failed:`, (error as Error)?.message);
    throw new Refusal(502, 'fetch_failed');
  }
  if (bytes.length > maxBytes) throw new Refusal(413, 'too_large');
  const image = sniffImage(bytes);
  if (!image || (mime && !mime.includes(image.contentType))) throw new Refusal(415, 'unsupported_image');

  // Stored emoji never keep metadata (utils/stripMetadata.ts).
  const clean = Buffer.from(await stripMediaBytes(bytes));
  const path = `${INSTANCE_EMOJI_FOLDER}/${randomUUID()}.${image.ext}`;
  const { error: uploadError } = await getSupabaseClient().storage
    .from(BUCKET)
    .upload(path, clean, { contentType: image.contentType, upsert: false });
  if (uploadError) {
    logger.error('Admin emojis: storing the image failed:', uploadError.message);
    throw new Refusal(500, 'upload_failed');
  }
  // getPublicUrl would name the internal host; PUBLIC_SUPABASE_URL defaults to SUPABASE_URL.
  const publicBase = (config.PUBLIC_SUPABASE_URL || config.SUPABASE_URL).replace(/\/+$/, '');
  return { path, publicUrl: `${publicBase}/storage/v1/object/public/${BUCKET}/${path}` };
}

async function removeObject(path: string): Promise<void> {
  try {
    await getSupabaseClient().storage.from(BUCKET).remove([path]);
  } catch (error) {
    logger.warn(`Admin emojis: removing ${path} failed:`, error);
  }
}

interface DbError {
  code?: string;
  message?: string;
}

/** import_remote_emoji / rehost_emoji refusals. */
function recordFailure(res: Response, error: DbError): void {
  const message = String(error.message ?? '');
  if (error.code === '23505') {
    if (/already imported/i.test(message)) res.status(409).json({ error: 'already_imported' });
    else if (/already hosted/i.test(message)) res.status(409).json({ error: 'not_hotlinked' });
    else res.status(409).json({ error: 'name_taken' });
    return;
  }
  if (error.code === 'P0002') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (error.code === '22023' && /^Emoji names/.test(message)) {
    res.status(400).json({ error: 'invalid_name' });
    return;
  }
  if (error.code === '22023' && /instance emojis are re-hosted/i.test(message)) {
    res.status(400).json({ error: 'not_instance' });
    return;
  }
  logger.error('Admin emojis: recording the emoji failed:', error);
  res.status(500).json({ error: 'internal_error' });
}

function refusalAnswer(res: Response, error: unknown): void {
  if (error instanceof Refusal) {
    res.status(error.status).json({ error: error.code });
    return;
  }
  throw error;
}

interface EmojiRow {
  id: string;
  name: string;
  url: string;
  imported_from: string | null;
}

const present = (row: EmojiRow) => ({ id: row.id, name: row.name, url: row.url, imported_from: row.imported_from ?? null });

async function admitWrite(req: Request, res: Response): Promise<InstanceAdmin | null> {
  const admin = await requireInstanceAdmin(req, res);
  if (!admin) return null;
  if (!(await writeLimit.take(res, admin.profileId))) return null;
  return admin;
}

router.post('/import', asyncHandler(async (req: Request, res: Response) => {
  const remoteId = req.body?.remoteEmojiId;
  const rawName = req.body?.name;
  const admin = await requireInstanceAdmin(req, res);
  if (!admin) return;
  if (typeof remoteId !== 'string' || !UUID.test(remoteId)) {
    res.status(400).json({ error: 'invalid_emoji' });
    return;
  }
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;
  if ((rawName !== undefined && rawName !== null && typeof rawName !== 'string') || (name !== null && !EMOJI_NAME.test(name))) {
    res.status(400).json({ error: 'invalid_name' });
    return;
  }
  if (!(await writeLimit.take(res, admin.profileId))) return;

  const supabase = getSupabaseClient();
  const { data: remote, error: readError } = await supabase
    .from('remote_emojis_cache')
    .select('id, url, imported_as')
    .eq('id', remoteId)
    .maybeSingle();
  if (readError) {
    logger.error('Admin emojis: reading the remote emoji failed:', readError);
    res.status(500).json({ error: 'internal_error' });
    return;
  }
  if (!remote) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (remote.imported_as) {
    res.status(409).json({ error: 'already_imported' });
    return;
  }

  let copy: { path: string; publicUrl: string };
  try {
    copy = await copyImage(remote.url);
  } catch (error) {
    refusalAnswer(res, error);
    return;
  }

  const { data, error } = await supabase.rpc('import_remote_emoji', {
    p_remote_emoji_id: remoteId,
    p_name: name,
    p_path: copy.path,
    p_url: copy.publicUrl,
    p_actor: admin.profileId,
  });
  if (error || !data) {
    await removeObject(copy.path);
    recordFailure(res, error ?? { message: 'import_remote_emoji returned no row' });
    return;
  }
  res.status(201).json({ emoji: present(data as EmojiRow) });
}));

router.post('/:id/rehost', asyncHandler(async (req: Request, res: Response) => {
  const admin = await admitWrite(req, res);
  if (!admin) return;
  const id = req.params.id;
  if (!UUID.test(id)) {
    res.status(400).json({ error: 'invalid_emoji' });
    return;
  }

  const supabase = getSupabaseClient();
  const { data: emoji, error: readError } = await supabase
    .from('emojis')
    .select('id, url, server_id, scope, domain')
    .eq('id', id)
    .maybeSingle();
  if (readError) {
    logger.error('Admin emojis: reading the emoji failed:', readError);
    res.status(500).json({ error: 'internal_error' });
    return;
  }
  if (!emoji) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (emoji.server_id || emoji.scope === 'user' || (typeof emoji.domain === 'string' && emoji.domain.trim())) {
    res.status(400).json({ error: 'not_instance' });
    return;
  }
  const publicBase = (config.PUBLIC_SUPABASE_URL || config.SUPABASE_URL).replace(/\/+$/, '');
  if (typeof emoji.url !== 'string' || !/^https?:\/\//i.test(emoji.url)) {
    res.status(400).json({ error: 'not_instance' });
    return;
  }
  if (emoji.url.startsWith(`${publicBase}/storage/v1/object/public/${BUCKET}/`)) {
    res.status(409).json({ error: 'not_hotlinked' });
    return;
  }

  let copy: { path: string; publicUrl: string };
  try {
    copy = await copyImage(emoji.url);
  } catch (error) {
    refusalAnswer(res, error);
    return;
  }

  const { data, error } = await supabase.rpc('rehost_emoji', {
    p_emoji_id: id,
    p_path: copy.path,
    p_url: copy.publicUrl,
    p_actor: admin.profileId,
  });
  if (error || !data) {
    await removeObject(copy.path);
    recordFailure(res, error ?? { message: 'rehost_emoji returned no row' });
    return;
  }
  res.json({ emoji: present(data as EmojiRow) });
}));

export default router;
