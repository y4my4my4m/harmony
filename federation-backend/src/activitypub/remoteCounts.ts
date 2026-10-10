/**
 * Figures a remote server reports for its own objects: the totalItems of an actor's outbox,
 * followers and following collections, and of a Note's replies, likes and shares
 * collections. Stored in the remote_* columns (migration 20261011500001), beside the local
 * counters the database maintains.
 *
 * Mastodon reads the three actor collections when it processes an account and keeps a total
 * only when it is a number (ActivityPub::ProcessAccountService#collection_info); it keeps a
 * Note's likes and shares totals as untrusted counts (ActivityPub::Activity::Create
 * #attach_counts). Deviation: a string of digits is accepted as well. Pleroma and Akkoma
 * answer a hidden collection with totalItems 0 or 403, Misskey answers 403 for a private one,
 * GoToSocial omits totalItems.
 */
import { SignatureService } from './SignatureService.js';
import { BlockedInstancesCache } from '../services/BlockedInstancesCache.js';
import { isActivityPubContentType, sameOrigin, urlHost } from '../utils/apOrigin.js';
import { logger } from '../utils/logger.js';
import { isHeartReaction } from '../utils/heartReaction.js';
import config from '../config/index.js';

/** Largest value of the integer columns the figures are stored in. */
const MAX_COUNT = 2_147_483_647;

/** A count: a non-negative integer number or a string of ASCII digits, within MAX_COUNT. */
export function parseCount(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^\s*\d{1,10}\s*$/.test(value)) {
    n = Number(value.trim());
  } else {
    return null;
  }
  return Number.isInteger(n) && n >= 0 && n <= MAX_COUNT ? n : null;
}

/** totalItems of an embedded collection; null for a bare URL or an absent or malformed total. */
export function collectionTotal(collection: unknown): number | null {
  if (!collection || typeof collection !== 'object' || Array.isArray(collection)) return null;
  return parseCount((collection as { totalItems?: unknown }).totalItems);
}

export interface EngagementTotals {
  replies: number | null;
  likes: number | null;
  shares: number | null;
}

/**
 * Totals a Note carries: its replies, likes and shares collections, else the count fields
 * some servers add beside them.
 */
export function noteEngagementTotals(note: any): EngagementTotals {
  return {
    replies: collectionTotal(note?.replies) ?? parseCount(note?.repliesCount),
    likes: collectionTotal(note?.likes) ?? parseCount(note?.favouritesCount) ?? parseCount(note?.likesCount),
    shares: collectionTotal(note?.shares) ?? parseCount(note?.sharesCount),
  };
}

/**
 * posts columns for the totals: each known figure, and the read time when any is known.
 * The posts trigger trg_posts_remote_engagement derives the displayed counters from them.
 */
export function engagementColumns(totals: EngagementTotals, at: Date = new Date()): Record<string, number | string> {
  const columns: Record<string, number | string> = {};
  if (totals.replies !== null) columns.remote_replies_count = totals.replies;
  if (totals.likes !== null) columns.remote_favorites_count = totals.likes;
  if (totals.shares !== null) columns.remote_reblogs_count = totals.shares;
  if (Object.keys(columns).length > 0) columns.remote_counts_fetched_at = at.toISOString();
  return columns;
}

/** engagementColumns of a Note. */
export function noteEngagementColumns(note: any, at: Date = new Date()): Record<string, number | string> {
  return engagementColumns(noteEngagementTotals(note), at);
}

/**
 * Figures of a Misskey note from POST /api/notes/show: renoteCount, repliesCount, and its
 * heart reactions out of the per-emoji `reactions` map.
 */
export function misskeyNoteTotals(note: any): EngagementTotals {
  let likes: number | null = null;
  if (note?.reactions && typeof note.reactions === 'object' && !Array.isArray(note.reactions)) {
    likes = 0;
    for (const [emoji, count] of Object.entries(note.reactions)) {
      const n = parseCount(count);
      if (n !== null && !emoji.startsWith(':') && isHeartReaction(emoji)) likes += n;
    }
  }
  return {
    replies: parseCount(note?.repliesCount),
    likes,
    shares: parseCount(note?.renoteCount),
  };
}

/**
 * A collection read: the total, null when the origin withholds it (401, 403, 404, 410, a
 * document without totalItems or not ActivityPub), undefined when the read failed
 * (timeout, 5xx, 429, unparseable body).
 */
export type CountRead = number | null | undefined;

export type SignedGet = (url: string, timeoutMs: number) => Promise<Response>;

const signedGet: SignedGet = (url, timeoutMs) => SignatureService.signedApFetch(url, {
  headers: {
    'Accept': 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
    'User-Agent': `Harmony/${config.INSTANCE_DOMAIN}`,
  },
  timeoutMs,
});

const WITHHELD_STATUSES = new Set([401, 403, 404, 410]);

/** Per-collection timeout, ms. */
export const COLLECTION_TIMEOUT_MS = 5_000;

/**
 * totalItems of the collection at `url`, read signed as the instance actor. Only a collection
 * on the actor's own host is read: another host's total says nothing about this actor.
 */
export async function fetchCollectionTotal(
  url: unknown,
  actorId: string,
  get: SignedGet = signedGet,
  timeoutMs: number = COLLECTION_TIMEOUT_MS,
): Promise<CountRead> {
  if (typeof url !== 'string' || !url) return null;
  if (!sameOrigin(url, actorId)) return null;
  const host = urlHost(url);
  if (!host || BlockedInstancesCache.isBlocked(host.replace(/:\d+$/, ''))) return null;

  try {
    const response = await get(url, timeoutMs);
    if (WITHHELD_STATUSES.has(response.status)) return null;
    if (!response.ok) return undefined;
    if (!isActivityPubContentType(response.headers.get('content-type'))) {
      try { await response.body?.cancel(); } catch { /* noop */ }
      return null;
    }
    const doc = await response.json();
    if (response.url && !sameOrigin(response.url, actorId)) return null;
    return collectionTotal(doc);
  } catch (err) {
    logger.debug(`Collection ${url} unreadable: ${err}`);
    return undefined;
  }
}

export interface ProfileCountReads {
  posts: CountRead;
  followers: CountRead;
  following: CountRead;
}

export interface CollectionUrls {
  federated_id: string;
  outbox_url?: string | null;
  followers_url?: string | null;
  following_url?: string | null;
}

/** The three actor collections, read in parallel. */
export async function fetchProfileCounts(urls: CollectionUrls, get: SignedGet = signedGet): Promise<ProfileCountReads> {
  const [posts, followers, following] = await Promise.all([
    fetchCollectionTotal(urls.outbox_url, urls.federated_id, get),
    fetchCollectionTotal(urls.followers_url, urls.federated_id, get),
    fetchCollectionTotal(urls.following_url, urls.federated_id, get),
  ]);
  return { posts, followers, following };
}

/**
 * profiles columns for the reads: each count that was read (a NULL marks it withheld) and the
 * read time. Empty when every read failed, so a stored figure outlives an unreachable origin.
 */
export function profileCountColumns(reads: ProfileCountReads, at: Date = new Date()): Record<string, number | string | null> {
  const columns: Record<string, number | string | null> = {};
  if (reads.posts !== undefined) columns.remote_posts_count = reads.posts;
  if (reads.followers !== undefined) columns.remote_followers_count = reads.followers;
  if (reads.following !== undefined) columns.remote_following_count = reads.following;
  if (Object.keys(columns).length > 0) columns.remote_counts_fetched_at = at.toISOString();
  return columns;
}

/** Age past which a profile's figures are read again, ms. */
export const PROFILE_COUNTS_TTL_MS = 6 * 60 * 60 * 1000;

/** Wait after a read that reached none of the three collections, ms. */
const FAILED_READ_BACKOFF_MS = 10 * 60 * 1000;

export interface RemoteProfileRow extends CollectionUrls {
  id: string;
  is_local?: boolean | null;
  remote_counts_fetched_at?: string | null;
}

export function profileCountsStale(row: { remote_counts_fetched_at?: string | null }, now: number = Date.now()): boolean {
  const at = row.remote_counts_fetched_at ? Date.parse(row.remote_counts_fetched_at) : NaN;
  return !Number.isFinite(at) || now - at >= PROFILE_COUNTS_TTL_MS;
}

const inflightProfileReads = new Map<string, Promise<Record<string, number | string | null> | null>>();
const failedProfileReads = new Map<string, number>();

/**
 * Reads and stores a remote profile's figures when the stored ones are older than
 * PROFILE_COUNTS_TTL_MS, or always with `force`. Concurrent calls for one profile share the
 * read. Returns the columns written; null when nothing was read.
 */
export async function refreshRemoteProfileCounts(
  supabase: any,
  row: RemoteProfileRow,
  options: { force?: boolean; get?: SignedGet } = {},
): Promise<Record<string, number | string | null> | null> {
  if (!row?.id || row.is_local === true || typeof row.federated_id !== 'string') return null;
  const now = Date.now();
  if (!options.force) {
    if (!profileCountsStale(row, now)) return null;
    const failedAt = failedProfileReads.get(row.id);
    if (failedAt !== undefined && now - failedAt < FAILED_READ_BACKOFF_MS) return null;
  }

  const inflight = inflightProfileReads.get(row.id);
  if (inflight) return inflight;

  const read = (async () => {
    const columns = profileCountColumns(await fetchProfileCounts(row, options.get));
    if (Object.keys(columns).length === 0) {
      failedProfileReads.set(row.id, Date.now());
      return null;
    }
    failedProfileReads.delete(row.id);
    const { error } = await supabase.from('profiles').update(columns).eq('id', row.id);
    if (error) {
      logger.warn(`Storing collection totals of ${row.federated_id} failed: ${error.message}`);
      return null;
    }
    return columns;
  })().finally(() => inflightProfileReads.delete(row.id));
  inflightProfileReads.set(row.id, read);
  return read;
}

/** Clears in-flight reads and backoffs. */
export function resetProfileCountState(): void {
  inflightProfileReads.clear();
  failedProfileReads.clear();
}
