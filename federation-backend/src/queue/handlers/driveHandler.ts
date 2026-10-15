/**
 * Drive upkeep (migrations 20261015100001_drive_core.sql, 20261015100002_drive_api.sql).
 *
 * drive-hash jobs (queued by the storage.objects trigger) and the sweep compute the SHA-256 of
 * a file from storage and record it with drive_record_hash; a blocked hash leaves the file gone
 * and its object is deleted. drive-purge jobs and the sweep delete the objects of gone files.
 * The sweep also expires ephemeral files and old trash (drive_expire_due), tracks objects the
 * upload trigger missed (drive_track_missing) and drops gone rows nothing shows
 * (drive_prune_gone). storage-api removes the row and the bytes.
 */

import crypto from 'node:crypto';
import { getSupabaseClient } from '../../config/supabase.js';
import { logger } from '../../utils/logger.js';

export interface DriveHashJobData {
  bucket?: unknown;
  path?: unknown;
}

const BUCKETS = new Set(['message_media', 'user_media']);
/** Objects per drive_objects_to_delete call and per storage remove. */
export const PURGE_BATCH = 200;
/** Files hashed per sweep run. */
export const HASH_BATCH = 100;
/** Seconds a signed download URL for hashing lives. */
const HASH_URL_TTL_SECONDS = 120;

function validObject(bucket: unknown, path: unknown): bucket is string {
  return typeof bucket === 'string' && BUCKETS.has(bucket)
    && typeof path === 'string' && path.length > 0 && path.length < 1024 && !/(^|\/)\.\.?(\/|$)/.test(path);
}

/** SHA-256 of an object, streamed from storage. */
export async function hashObject(bucket: string, path: string): Promise<string> {
  const { data, error } = await getSupabaseClient().storage.from(bucket).createSignedUrl(path, HASH_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) throw new Error(`sign ${bucket}/${path}: ${error?.message ?? 'no URL'}`);
  const response = await fetch(data.signedUrl);
  if (!response.ok || !response.body) throw new Error(`download ${bucket}/${path}: HTTP ${response.status}`);
  const hash = crypto.createHash('sha256');
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return hash.digest('hex');
}

async function removeObjects(bucket: string, paths: string[]): Promise<number> {
  if (paths.length === 0) return 0;
  const { data, error } = await getSupabaseClient().storage.from(bucket).remove(paths);
  if (error) throw new Error(`remove ${bucket} objects: ${error.message}`);
  return data?.length ?? 0;
}

async function hashAndRecord(bucket: string, path: string): Promise<void> {
  const sha256 = await hashObject(bucket, path);
  const { data, error } = await getSupabaseClient().rpc('drive_record_hash', {
    p_bucket: bucket,
    p_path: path,
    p_sha256: sha256,
  });
  if (error) throw new Error(`drive_record_hash: ${error.message}`);
  if (data === 'blocked') {
    await removeObjects(bucket, [path]);
    logger.info(`Removed ${bucket}/${path}: its bytes are blocked`);
  }
}

export async function handleDriveHashJob(data: DriveHashJobData): Promise<void> {
  if (!validObject(data?.bucket, data?.path)) return;
  await hashAndRecord(data.bucket, data.path as string);
}

/** Deletes the objects of gone files, a batch per bucket at a time. */
export async function purgeGoneObjects(maxBatches = 10): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const { data, error } = await getSupabaseClient().rpc('drive_objects_to_delete', { p_limit: PURGE_BATCH });
    if (error) throw new Error(`drive_objects_to_delete: ${error.message}`);
    const rows = (data as Array<{ bucket: string; path: string }> | null) ?? [];
    if (rows.length === 0) break;
    let removed = 0;
    for (const bucket of BUCKETS) {
      removed += await removeObjects(bucket, rows.filter((r) => r.bucket === bucket).map((r) => r.path));
    }
    total += removed;
    if (removed === 0 || rows.length < PURGE_BATCH) break;
  }
  if (total > 0) logger.info(`Deleted ${total} object(s) of gone Drive files`);
  return total;
}

export async function handleDrivePurgeJob(): Promise<void> {
  await purgeGoneObjects();
}

async function rpcCount(name: string, args: Record<string, unknown> = {}): Promise<number> {
  const { data, error } = await getSupabaseClient().rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return typeof data === 'number' ? data : 0;
}

export async function sweepDrive(): Promise<void> {
  const expired = await rpcCount('drive_expire_due');
  if (expired > 0) logger.info(`${expired} Drive file(s) expired or left the trash`);

  await purgeGoneObjects();

  const tracked = await rpcCount('drive_track_missing', { p_limit: 500 });
  if (tracked > 0) logger.info(`Tracked ${tracked} untracked upload(s) in Drive`);

  const { data, error } = await getSupabaseClient().rpc('drive_hash_pending', { p_limit: HASH_BATCH });
  if (error) throw new Error(`drive_hash_pending: ${error.message}`);
  let hashed = 0;
  for (const row of (data as Array<{ bucket: string; path: string }> | null) ?? []) {
    try {
      await hashAndRecord(row.bucket, row.path);
      hashed++;
    } catch (err) {
      logger.warn(`Drive hash of ${row.bucket}/${row.path} failed: ${(err as Error).message}`);
    }
  }
  if (hashed > 0) logger.info(`Hashed ${hashed} Drive file(s)`);

  const pruned = await rpcCount('drive_prune_gone', { p_limit: 500 });
  if (pruned > 0) logger.info(`Dropped ${pruned} old gone Drive row(s)`);
}
