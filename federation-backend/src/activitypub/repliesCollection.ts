/**
 * Replies of a remote Note, read from its `replies` collection and stored as posts.
 *
 * Mastodon embeds the collection's first page in the Note, holding only the author's own
 * replies; replies by other accounts begin at that page's `next`
 * (`?only_other_accounts=true&page=true`) and continue page by page, replies made on the
 * serving host embedded as objects, others listed as URIs (ActivityPub::RepliesController).
 * Pleroma and Akkoma serve a paged collection of URIs and embedded objects. Misskey and its
 * forks publish no replies collection. Mastodon's ActivityPub::FetchAllRepliesWorker bounds
 * a thread at 1000 replies and 500 pages; one post here is bounded by ReplyCrawlLimits.
 */
import { sameOrigin, urlHost, type FetchedDocument } from '../utils/apOrigin.js';
import { logger } from '../utils/logger.js';

const NOTE_TYPES = new Set(['Note', 'Article', 'Question']);
const PAGE_TYPES = new Set(['CollectionPage', 'OrderedCollectionPage']);

export interface ReplyCrawlLimits {
  /** Collection pages fetched; an embedded page costs none. */
  maxPages: number;
  /** Distinct replies collected. */
  maxReplies: number;
  /** Epoch ms after which no further request starts. */
  deadline: number;
}

export const DEFAULT_REPLY_CRAWL = { maxPages: 5, maxReplies: 200, timeoutMs: 30_000 } as const;

/** A reply named by a collection; `object` is an embedded copy served by the reply's own host. */
export interface ReplyRef {
  id: string;
  object?: any;
}

export interface ReplyWalk {
  refs: ReplyRef[];
  pages: number;
  /** A page limit, reply limit or the deadline stopped the walk before the collection's end. */
  truncated: boolean;
}

export type FetchDocument = (url: string) => Promise<FetchedDocument | null>;

function itemsOf(doc: any): unknown[] {
  if (Array.isArray(doc?.orderedItems)) return doc.orderedItems;
  if (Array.isArray(doc?.items)) return doc.items;
  return [];
}

function refOf(item: unknown, source: string): ReplyRef | null {
  let value: any = item;
  if (value && typeof value === 'object' && value.type === 'Create') value = value.object;
  if (typeof value === 'string') {
    return urlHost(value) ? { id: value } : null;
  }
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !urlHost(value.id)) {
    return null;
  }
  if (NOTE_TYPES.has(value.type) && sameOrigin(value.id, source)) {
    return { id: value.id, object: value };
  }
  return { id: value.id };
}

/**
 * Reply references listed by `replies` (a URL or an embedded collection), following `first`
 * and `next` across pages on the post's host. `postId` is the Note's id; every page read must
 * be served from its host.
 */
export async function walkRepliesCollection(
  replies: unknown,
  postId: string,
  fetchDoc: FetchDocument,
  limits: ReplyCrawlLimits,
): Promise<ReplyWalk> {
  const refs = new Map<string, ReplyRef>();
  const visited = new Set<string>();
  let pages = 0;
  let truncated = false;

  const load = async (url: string): Promise<{ doc: any; source: string } | null> => {
    if (visited.has(url) || !sameOrigin(url, postId)) return null;
    if (pages >= limits.maxPages || Date.now() >= limits.deadline) {
      truncated = true;
      return null;
    }
    visited.add(url);
    pages++;
    const fetched = await fetchDoc(url);
    if (!fetched || !sameOrigin(fetched.finalUrl, postId)) return null;
    return { doc: fetched.doc, source: fetched.finalUrl };
  };

  let current: { doc: any; source: string } | null = null;
  if (typeof replies === 'string') {
    current = await load(replies);
  } else if (replies && typeof replies === 'object') {
    const embedded = replies as any;
    if (embedded.first !== undefined || Array.isArray(embedded.items) || Array.isArray(embedded.orderedItems)) {
      current = { doc: embedded, source: postId };
      if (typeof embedded.id === 'string') visited.add(embedded.id);
    } else if (typeof embedded.id === 'string') {
      current = await load(embedded.id);
    }
  }

  while (current) {
    const { doc, source } = current;
    for (const item of itemsOf(doc)) {
      const ref = refOf(item, source);
      if (!ref || ref.id === postId || refs.has(ref.id)) continue;
      if (refs.size >= limits.maxReplies) {
        truncated = true;
        break;
      }
      refs.set(ref.id, ref);
    }
    if (truncated) break;

    const isPage = PAGE_TYPES.has(doc?.type);
    const nextRef = !isPage && doc?.first !== undefined ? doc.first : doc?.next;
    if (!nextRef) break;
    if (refs.size >= limits.maxReplies) {
      truncated = true;
      break;
    }
    if (typeof nextRef === 'object') {
      const nextId = typeof nextRef.id === 'string' ? nextRef.id : null;
      if (nextId && visited.has(nextId)) break;
      if (nextRef.next !== undefined || Array.isArray(nextRef.items) || Array.isArray(nextRef.orderedItems)) {
        if (nextId) visited.add(nextId);
        current = { doc: { ...nextRef, type: nextRef.type ?? 'CollectionPage' }, source };
        continue;
      }
      current = nextId ? await load(nextId) : null;
      continue;
    }
    current = typeof nextRef === 'string' ? await load(nextRef) : null;
  }

  return { refs: [...refs.values()], pages, truncated };
}

/** How one reply ended up. */
export type ReplyOutcome = 'stored' | 'existing' | 'skipped';

export interface ReplyStore {
  /** Hosts this instance refuses content from. */
  isBlockedHost(host: string): boolean;
  /** The subset of `ids` already stored as posts. */
  existing(ids: string[]): Promise<Set<string>>;
  /** Stores the reply at `id`, fetched from its origin. */
  storeById(id: string): Promise<ReplyOutcome>;
  /** Stores an embedded reply from its own host without fetching it again. */
  storeObject(object: any): Promise<ReplyOutcome>;
}

export interface ReplyCrawl {
  /** 'no_collection': the Note publishes no replies collection. */
  status: 'ok' | 'no_collection';
  found: number;
  stored: number;
  existing: number;
  skipped: number;
  pages: number;
  truncated: boolean;
}

/** Parallel stores per crawl. */
const STORE_CONCURRENCY = 4;

/** Outcome counts of storing a list of replies. */
export interface ReplyStoreCounts {
  stored: number;
  existing: number;
  skipped: number;
  /** The deadline passed with replies left unstored. */
  truncated: boolean;
}

/** ap_ids per existence query; each id is a filter value in the request URL. */
const EXISTING_CHUNK = 50;

/**
 * Stores each reply not held yet. Replies on blocked hosts are skipped before any request;
 * no store starts after the deadline.
 */
export async function storeReplies(refs: ReplyRef[], store: ReplyStore, deadline: number): Promise<ReplyStoreCounts> {
  const counts: ReplyStoreCounts = { stored: 0, existing: 0, skipped: 0, truncated: false };

  const allowed = refs.filter((ref) => {
    const host = urlHost(ref.id)?.replace(/:\d+$/, '');
    if (!host || store.isBlockedHost(host)) {
      counts.skipped++;
      return false;
    }
    return true;
  });

  const held = new Set<string>();
  for (let i = 0; i < allowed.length; i += EXISTING_CHUNK) {
    for (const id of await store.existing(allowed.slice(i, i + EXISTING_CHUNK).map((ref) => ref.id))) {
      held.add(id);
    }
  }
  const pending = allowed.filter((ref) => {
    if (held.has(ref.id)) {
      counts.existing++;
      return false;
    }
    return true;
  });

  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const ref = pending[next++];
      if (Date.now() >= deadline) {
        counts.truncated = true;
        counts.skipped++;
        continue;
      }
      try {
        const outcome = ref.object ? await store.storeObject(ref.object) : await store.storeById(ref.id);
        counts[outcome]++;
      } catch (err) {
        logger.debug(`Storing reply ${ref.id} failed: ${err}`);
        counts.skipped++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STORE_CONCURRENCY, pending.length) }, worker));
  return counts;
}

/** Walks the Note's replies collection and stores each reply not held yet. */
export async function crawlReplies(
  note: any,
  fetchDoc: FetchDocument,
  store: ReplyStore,
  limits: ReplyCrawlLimits,
): Promise<ReplyCrawl> {
  if (!note?.replies || typeof note.id !== 'string') {
    return { status: 'no_collection', found: 0, stored: 0, existing: 0, skipped: 0, pages: 0, truncated: false };
  }
  const walk = await walkRepliesCollection(note.replies, note.id, fetchDoc, limits);
  const counts = await storeReplies(walk.refs, store, limits.deadline);
  return {
    status: 'ok',
    found: walk.refs.length,
    stored: counts.stored,
    existing: counts.existing,
    skipped: counts.skipped,
    pages: walk.pages,
    truncated: walk.truncated || counts.truncated,
  };
}
