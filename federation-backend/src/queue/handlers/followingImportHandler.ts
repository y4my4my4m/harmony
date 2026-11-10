/**
 * following-import jobs, { import_id } (migration 20261109700001_following_import.sql).
 *
 * A job runs one batch: claim_following_import_batch, a resolve of each handle, then
 * finish_following_import_item, which follows the account or records why not. It queues the next
 * job itself, after the delay the claim names. An import whose next_run_at passed five minutes ago
 * is queued again. A second job on the same import is harmless: claims skip locked rows.
 *
 * Mirrors Mastodon's BulkImportWorker. Handles of one host resolve one at a time, a remote fetch
 * being five requests (WebFinger, actor, three collection totals).
 */

import { getSupabaseClient } from '../../config/supabase.js';
import config from '../../config/index.js';
import { findStoredRemoteAccount, resolveRemoteAccount } from '../../activitypub/ActorService.js';
import { parseAccountHandle } from '../../activitypub/accountMigration.js';
import { BlockedInstancesCache } from '../../services/BlockedInstancesCache.js';
import { federationSwitches } from '../../services/FederationSwitches.js';
import { logger } from '../../utils/logger.js';
import { bullmqManager, type FederationJobData } from '../BullMQManager.js';

const BATCH_SIZE = 25;
const HOSTS_AT_ONCE = 4;
const HOST_GAP_MS = 250;
/** A stored remote profile newer than this is followed without a fetch. */
const STORED_FRESH_MS = 24 * 60 * 60 * 1000;
/** Wait before another attempt at an unreachable host, multiplied by the attempt. */
const RETRY_SECONDS = 600;

export type HandleResolution =
  | { id: string; fetched: boolean }
  | { failure: 'invalid_handle' | 'not_found' | 'instance_blocked' | 'federation_off' | 'unreachable'; retry?: boolean; fetched: boolean };

interface ImportItem {
  id: number;
  handle: string;
}

/** The profile a handle names, stored now if it was not. */
export async function resolveImportHandle(handle: string): Promise<HandleResolution> {
  const parsed = parseAccountHandle(handle);
  if (!parsed?.domain) return { failure: 'invalid_handle', fetched: false };
  const supabase = getSupabaseClient();

  if (parsed.domain === config.INSTANCE_DOMAIN.toLowerCase()) {
    const { data } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', parsed.username)
      .eq('is_local', true)
      .is('deleted_at', null)
      .maybeSingle();
    return data ? { id: data.id, fetched: false } : { failure: 'not_found', fetched: false };
  }

  if (BlockedInstancesCache.isBlocked(parsed.domain.replace(/:\d+$/, ''))) {
    return { failure: 'instance_blocked', fetched: false };
  }
  const switches = await federationSwitches();
  if (!switches.inbound || !switches.outbound) return { failure: 'federation_off', fetched: false };

  const stored = await findStoredRemoteAccount(supabase, parsed.username, parsed.domain);
  if (stored?.last_synced_at && Date.now() - new Date(stored.last_synced_at).getTime() < STORED_FRESH_MS) {
    return { id: stored.id, fetched: false };
  }

  const resolved = await resolveRemoteAccount(parsed.username, parsed.domain);
  if (resolved.ok) return { id: resolved.user.id, fetched: true };
  if (stored) return { id: stored.id, fetched: true };
  if (resolved.status === 404) return { failure: 'not_found', fetched: true };
  if (resolved.status >= 500 || resolved.status === 429) return { failure: 'unreachable', retry: true, fetched: true };
  return { failure: 'not_found', fetched: true };
}

async function runItem(item: ImportItem): Promise<boolean> {
  let resolution: HandleResolution;
  try {
    resolution = await resolveImportHandle(item.handle);
  } catch (err) {
    logger.warn(`Following import: resolving ${item.handle} failed: ${(err as Error)?.message}`);
    resolution = { failure: 'unreachable', retry: true, fetched: true };
  }

  const outcome = 'failure' in resolution
    ? { p_target_profile_id: null, p_failure: resolution.failure, p_retry_seconds: resolution.retry ? RETRY_SECONDS : null }
    : { p_target_profile_id: resolution.id, p_failure: null, p_retry_seconds: null };
  const { error } = await getSupabaseClient().rpc('finish_following_import_item', { p_item_id: item.id, ...outcome });
  // The claim expires and the item runs again.
  if (error) logger.error(`Following import: finishing item ${item.id} failed: ${error.message}`);
  return resolution.fetched;
}

async function runItems(items: ImportItem[]): Promise<void> {
  const hosts = new Map<string, ImportItem[]>();
  for (const item of items) {
    const host = item.handle.slice(item.handle.lastIndexOf('@') + 1).toLowerCase();
    hosts.set(host, [...(hosts.get(host) ?? []), item]);
  }
  const queue = [...hosts.values()];
  await Promise.all(Array.from({ length: Math.min(HOSTS_AT_ONCE, queue.length) }, async () => {
    for (let group = queue.shift(); group; group = queue.shift()) {
      for (const item of group) {
        const fetched = await runItem(item);
        if (fetched) await new Promise((resolve) => setTimeout(resolve, HOST_GAP_MS));
      }
    }
  }));
}

/** One batch of an import. retryAfter is the seconds until the next batch can claim anything. */
export async function runFollowingImportBatch(importId: string): Promise<{ finished: boolean; retryAfter: number }> {
  const { data, error } = await getSupabaseClient().rpc('claim_following_import_batch', {
    p_import_id: importId,
    p_limit: BATCH_SIZE,
  });
  if (error) throw new Error(`claim_following_import_batch ${importId}: ${error.message}`);
  if (!data || data.finished) return { finished: true, retryAfter: 0 };
  await runItems(Array.isArray(data.items) ? data.items : []);
  return { finished: false, retryAfter: typeof data.retry_after === 'number' ? data.retry_after : 0 };
}

export async function handleFollowingImportJob(data: FederationJobData): Promise<void> {
  const importId = (data as { import_id?: unknown }).import_id;
  if (typeof importId !== 'string' || !importId) {
    logger.warn('following-import job without import_id, dropped');
    return;
  }
  const { finished, retryAfter } = await runFollowingImportBatch(importId);
  if (!finished) await bullmqManager.addJob('following-import', data, retryAfter * 1000);
}
