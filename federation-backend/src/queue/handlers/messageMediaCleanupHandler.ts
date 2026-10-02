/**
 * Deletes message_media objects nothing needs any more.
 *
 * delete-message-media jobs carry the paths a message update or delete dropped
 * (public.queue_message_media_cleanup, migration 20261006900001_private_user_media.sql). The
 * hourly sweep (maintenance task sweep-message-media) takes every object older than a day,
 * which spares uploads not sent yet and catches jobs that were never delivered. Both delete
 * only what public.message_media_deletable returns: no message, report snapshot or open data
 * export still references it. storage-api removes the row and the bytes.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { logger } from '../../utils/logger.js';
import { MESSAGE_MEDIA_BUCKET, isPrivateMediaPath } from '../../utils/privateMedia.js';

export interface MessageMediaCleanupJobData {
  paths?: unknown;
}

/** Age below which the sweep leaves an object: an upload the composer has not sent. */
export const SWEEP_MIN_AGE = '24 hours';
/** Objects per message_media_deletable call and per storage remove. */
export const SWEEP_BATCH = 500;
/** Batches per sweep run. */
const SWEEP_MAX_BATCHES = 20;

async function deletable(paths: string[] | null, minAge: string): Promise<string[]> {
  const { data, error } = await getSupabaseClient().rpc('message_media_deletable', {
    p_paths: paths,
    p_min_age: minAge,
    p_limit: SWEEP_BATCH,
  });
  if (error) throw new Error(`message_media_deletable: ${error.message}`);
  return ((data as unknown[]) ?? []).map((row) => (typeof row === 'string' ? row : (row as any)?.message_media_deletable))
    .filter((name): name is string => typeof name === 'string');
}

async function remove(paths: string[]): Promise<number> {
  if (paths.length === 0) return 0;
  const { data, error } = await getSupabaseClient().storage.from(MESSAGE_MEDIA_BUCKET).remove(paths);
  if (error) throw new Error(`remove message_media objects: ${error.message}`);
  return data?.length ?? 0;
}

export async function handleMessageMediaCleanupJob(data: MessageMediaCleanupJobData): Promise<void> {
  const paths = Array.isArray(data?.paths) ? data.paths.filter(isPrivateMediaPath) : [];
  if (paths.length === 0) return;
  const removed = await remove(await deletable(paths, '0'));
  if (removed > 0) logger.info(`Removed ${removed} message_media object(s) of a deleted or edited message`);
}

export async function sweepMessageMedia(): Promise<number> {
  let total = 0;
  for (let i = 0; i < SWEEP_MAX_BATCHES; i++) {
    const batch = await deletable(null, SWEEP_MIN_AGE);
    if (batch.length === 0) break;
    const removed = await remove(batch);
    total += removed;
    if (removed === 0 || batch.length < SWEEP_BATCH) break;
  }
  if (total > 0) logger.info(`Swept ${total} unreferenced message_media object(s)`);
  return total;
}
