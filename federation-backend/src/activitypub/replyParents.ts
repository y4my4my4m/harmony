/**
 * Parents of stored replies whose parent was not stored on receipt (POST /resolve-reply-parents).
 *
 * ActivityProcessor keeps such a reply with in_reply_to NULL and the parent's ActivityPub id in
 * metadata.in_reply_to_ap_url. Each named post the caller reads (posts RLS, through `reader`)
 * that holds such an id has it fetched through ActivityProcessor.fetchAndCreateRemotePost, the
 * path /resolve-post and inbound Creates use, which stores the parent and the chain above it.
 * The reply is then linked to the stored parent. A fetch that fails is not repeated for
 * FAILURE_TTL_MS; concurrent requests for one id share one fetch.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';
import { validateExternalUrl } from '../utils/ssrfProtection.js';

/** linked: the post's in_reply_to is set. unavailable: its parent could not be fetched.
 *  none: not a reply waiting for its parent, or not readable by the caller. */
export type ReplyParentResult = 'linked' | 'unavailable' | 'none';

export interface StoredParent {
  id: string;
  conversation_root_id: string | null;
}

export type FetchParent = (url: string) => Promise<StoredParent | null>;

export const MAX_REPLY_PARENT_POSTS = 20;
export const FAILURE_TTL_MS = 30 * 60_000;
const FAILURE_CACHE_LIMIT = 10_000;
/** Parent fetches in flight per request. */
const CONCURRENCY = 4;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parent id -> time its failed fetch may be retried. Insertion order is age order. */
const failedUntil = new Map<string, number>();
const inFlight = new Map<string, Promise<StoredParent | null>>();

function failedRecently(url: string, now: number): boolean {
  const until = failedUntil.get(url);
  if (until === undefined) return false;
  if (until > now) return true;
  failedUntil.delete(url);
  return false;
}

function noteFailure(url: string, now: number) {
  failedUntil.delete(url);
  failedUntil.set(url, now + FAILURE_TTL_MS);
  while (failedUntil.size > FAILURE_CACHE_LIMIT) {
    const oldest = failedUntil.keys().next().value;
    if (oldest === undefined) break;
    failedUntil.delete(oldest);
  }
}

function fetchOnce(url: string, fetchParent: FetchParent): Promise<StoredParent | null> {
  const running = inFlight.get(url);
  if (running) return running;
  const started = (async () => {
    try {
      validateExternalUrl(url);
    } catch {
      return null;
    }
    try {
      return await fetchParent(url);
    } catch (error) {
      logger.warn(`Reply parent fetch failed for ${url}:`, error);
      return null;
    }
  })().finally(() => inFlight.delete(url));
  inFlight.set(url, started);
  return started;
}

/**
 * Results by post id for the posts `postIds` names. `reader` reads as the caller; `writer`
 * links replies (service role).
 */
export async function resolveReplyParents(
  postIds: unknown,
  reader: SupabaseClient,
  writer: SupabaseClient,
  fetchParent: FetchParent,
  now: () => number = Date.now,
): Promise<Record<string, ReplyParentResult>> {
  const ids = Array.isArray(postIds)
    ? [...new Set(postIds.filter((id): id is string => typeof id === 'string' && UUID.test(id)))]
        .slice(0, MAX_REPLY_PARENT_POSTS)
    : [];
  const results: Record<string, ReplyParentResult> = {};
  if (ids.length === 0) return results;
  for (const id of ids) results[id] = 'none';

  const { data: rows, error } = await reader
    .from('posts')
    .select('id, in_reply_to, metadata')
    .in('id', ids);
  if (error) {
    logger.warn(`Reply parent lookup failed: ${error.message}`);
    return results;
  }

  const waiting = new Map<string, string[]>();
  for (const row of rows ?? []) {
    if (row.in_reply_to) {
      results[row.id] = 'linked';
      continue;
    }
    const url = row.metadata?.in_reply_to_ap_url;
    if (typeof url !== 'string' || !url) continue;
    waiting.set(url, [...(waiting.get(url) ?? []), row.id]);
  }

  const urls = [...waiting.keys()];
  const work = async (url: string) => {
    const replies = waiting.get(url)!;
    if (failedRecently(url, now())) {
      for (const id of replies) results[id] = 'unavailable';
      return;
    }
    const parent = await fetchOnce(url, fetchParent);
    if (!parent) {
      noteFailure(url, now());
      for (const id of replies) results[id] = 'unavailable';
      return;
    }
    // fetchAndCreateRemotePost links replies waiting on the parent's canonical id and url; a
    // reply naming another form of it (a redirect, a pretty URL) is linked here.
    const { error: linkError } = await writer
      .from('posts')
      .update({ in_reply_to: parent.id, conversation_root_id: parent.conversation_root_id || parent.id })
      .in('id', replies)
      .is('in_reply_to', null);
    if (linkError) {
      logger.warn(`Linking replies to ${parent.id} failed: ${linkError.message}`);
      for (const id of replies) results[id] = 'unavailable';
      return;
    }
    for (const id of replies) results[id] = 'linked';
  };

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    await Promise.all(urls.slice(i, i + CONCURRENCY).map(work));
  }
  return results;
}

/** Forgets failed fetches. Tests only. */
export function resetReplyParentFailures() {
  failedUntil.clear();
  inFlight.clear();
}
