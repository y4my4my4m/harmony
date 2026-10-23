/**
 * Public ActivityPub, WebFinger and NodeInfo documents served from memory for a short window,
 * one build shared by concurrent identical requests.
 *
 * A post boosted by a large account reaches thousands of servers within a minute, and each
 * fetches the Note, its author, the author's WebFinger and featured collection (Mastodon
 * FetchRemoteStatusService, ResolveAccountService, SynchronizeFeaturedCollectionService).
 * Built per request that is about nine PostgREST calls a server; measured on four cores,
 * 2,000 servers cost ~35 CPU seconds across the backend, PostgREST and Postgres
 * (~/harmony-notes/ops/stampede).
 *
 * Stored: a GET of a path below, asked as ActivityPub (or any non-HTML type under
 * /.well-known and /nodeinfo), answered 200 or 410 with Cache-Control public and a max-age,
 * no Set-Cookie, and a Vary of Accept, Accept-Encoding or Origin only. A response varying by
 * signer is never stored; requests waiting on it run their own handler.
 * Key: the Accept class and the URL with its query. Lifetime: the response's max-age, at
 * most DOCUMENT_CACHE_TTL_MS. invalidateDocuments() drops entries early, in every server
 * process through Redis.
 */

import type { NextFunction, Request, Response } from 'express';
import config from '../config/index.js';
import { redis } from '../services/RedisService.js';
import { logger } from '../utils/logger.js';

/** Paths whose public answers do not depend on who asks. */
const CACHEABLE_PATH = new RegExp([
  '^/users/[^/]+(/(featured|outbox|followers|following))?/?$',
  '^/@[^/]+(/[0-9a-fA-F-]{36})?/?$',
  '^/posts/[0-9a-fA-F-]{36}(/(likes|shares|replies|context))?/?$',
  '^/\\.well-known/(webfinger|nodeinfo|host-meta)$',
  '^/nodeinfo/[0-9.]+$',
].join('|'));

const WELL_KNOWN = /^\/(\.well-known|nodeinfo)\//;
const SAFE_VARY = new Set(['accept', 'accept-encoding', 'origin']);
/** Per-response or per-client headers a replay must not repeat. */
const DROPPED_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'date',
  'set-cookie', 'x-harmony-cache', 'retry-after',
]);
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const INVALIDATE_CHANNEL = 'doc-cache:invalidate';

interface Entry {
  path: string;
  status: number;
  headers: Array<[string, string | string[]]>;
  body: Buffer;
  expires: number;
}

/** Insertion order is recency: a hit moves its entry to the end. */
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry | null>>();
let storedBytes = 0;
/** Invalidation counter, and the value it had when each path was last invalidated. */
let invalidationSeq = 0;
const invalidatedAt = new Map<string, number>();
const MAX_INVALIDATED_PATHS = 1000;

function covers(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Whether a path was invalidated after `seq`: a build started then holds older data. */
function invalidatedSince(path: string, seq: number): boolean {
  for (const [prefix, at] of invalidatedAt) {
    if (at > seq && covers(path, prefix)) return true;
  }
  return false;
}
let subscribed = false;

function acceptClass(req: Request): string | null {
  const accept = String(req.headers.accept ?? '').toLowerCase();
  if (/application\/(activity|ld)\+json/.test(accept)) return 'ap';
  if (!WELL_KNOWN.test(req.path)) return null;
  if (accept.includes('text/html')) return null;
  if (accept.includes('application/jrd+json')) return 'jrd';
  if (accept.includes('application/xrd+xml')) return 'xrd';
  return 'json';
}

function maxAgeMs(cacheControl: string): number {
  const value = cacheControl.toLowerCase();
  if (!/(^|,)\s*public\s*(,|$)/.test(value) || /private|no-store|no-cache/.test(value)) return 0;
  const age = /max-age=(\d+)/.exec(value);
  return age ? Number(age[1]) * 1000 : 0;
}

function storable(res: Response, body: Buffer): number {
  if (res.statusCode !== 200 && res.statusCode !== 410) return 0;
  if (res.getHeader('set-cookie') !== undefined || body.length > MAX_ENTRY_BYTES) return 0;
  const vary = String(res.getHeader('vary') ?? '').toLowerCase().split(',').map((v) => v.trim()).filter(Boolean);
  if (vary.some((v) => !SAFE_VARY.has(v))) return 0;
  return Math.min(maxAgeMs(String(res.getHeader('cache-control') ?? '')), config.DOCUMENT_CACHE_TTL_MS);
}

function forget(key: string): void {
  const entry = store.get(key);
  if (!entry) return;
  store.delete(key);
  storedBytes -= entry.body.length;
}

function remember(key: string, entry: Entry): void {
  forget(key);
  store.set(key, entry);
  storedBytes += entry.body.length;
  while (store.size > MAX_ENTRIES || storedBytes > MAX_TOTAL_BYTES) forget(store.keys().next().value as string);
}

function replay(req: Request, res: Response, entry: Entry, how: 'hit' | 'shared'): void {
  res.status(entry.status);
  for (const [name, value] of entry.headers) res.setHeader(name, value);
  res.setHeader('X-Harmony-Cache', how);
  // req.fresh compares If-None-Match and If-Modified-Since with the ETag and Last-Modified set above.
  if (entry.status === 200 && req.fresh) {
    res.status(304).end();
    return;
  }
  res.end(entry.body);
}

/**
 * Collects what the handler writes. compression() is mounted earlier, so its wrappers sit
 * underneath these and the chunks seen here are the uncompressed body.
 */
function capture(res: Response, done: (body: Buffer | null) => void): void {
  const chunks: Buffer[] = [];
  const write = res.write.bind(res) as (...args: any[]) => boolean;
  const end = res.end.bind(res) as (...args: any[]) => Response;
  const keep = (chunk: unknown, encoding?: unknown) => {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, (typeof encoding === 'string' ? encoding : 'utf8') as BufferEncoding));
  };
  (res as any).write = (chunk: unknown, ...rest: unknown[]) => {
    keep(chunk, rest[0]);
    return write(chunk, ...rest);
  };
  (res as any).end = (chunk?: unknown, ...rest: unknown[]) => {
    keep(chunk, rest[0]);
    return end(chunk, ...rest);
  };
  let settled = false;
  res.on('finish', () => { if (!settled) { settled = true; done(Buffer.concat(chunks)); } });
  res.on('close', () => { if (!settled) { settled = true; done(null); } });
}

export function documentCache() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (config.DOCUMENT_CACHE_TTL_MS <= 0 || req.method !== 'GET' || !CACHEABLE_PATH.test(req.path)) return next();
    const kind = acceptClass(req);
    if (!kind) return next();
    const key = `${kind} ${req.originalUrl}`;

    const cached = store.get(key);
    if (cached && cached.expires > Date.now()) {
      remember(key, cached);
      return replay(req, res, cached, 'hit');
    }
    if (cached) forget(key);

    const pending = inflight.get(key);
    if (pending) {
      pending.then((entry) => (entry ? replay(req, res, entry, 'shared') : next()), () => next());
      return;
    }

    let resolve!: (entry: Entry | null) => void;
    inflight.set(key, new Promise<Entry | null>((r) => { resolve = r; }));
    const startedAt = invalidationSeq;
    res.setHeader('X-Harmony-Cache', 'miss');
    capture(res, (body) => {
      inflight.delete(key);
      const ttl = body && !invalidatedSince(req.path, startedAt) ? storable(res, body) : 0;
      if (!body || ttl <= 0) return resolve(null);
      const headers = Object.entries(res.getHeaders())
        .filter(([name, value]) => value !== undefined && !DROPPED_HEADERS.has(name) && !/^x?-?ratelimit/i.test(name))
        .map(([name, value]) => [name, typeof value === 'number' ? String(value) : value] as [string, string | string[]]);
      const entry: Entry = { path: req.path, status: res.statusCode, headers, body, expires: Date.now() + ttl };
      remember(key, entry);
      resolve(entry);
    });
    next();
  };
}

/** Drops the entries of each path, and of every path below it (`/users/a` takes `/users/a/featured`). */
function invalidateLocal(paths: string[]): number {
  invalidationSeq++;
  for (const p of paths) {
    invalidatedAt.delete(p);
    invalidatedAt.set(p, invalidationSeq);
  }
  while (invalidatedAt.size > MAX_INVALIDATED_PATHS) invalidatedAt.delete(invalidatedAt.keys().next().value as string);
  let dropped = 0;
  for (const [key, entry] of store) {
    if (paths.some((p) => covers(entry.path, p))) {
      forget(key);
      dropped++;
    }
  }
  return dropped;
}

/** Drops cached documents of these paths in this process and in every server process. */
export async function invalidateDocuments(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  invalidateLocal(paths);
  const client = redis.getClient();
  if (!client) return;
  try {
    await client.publish(INVALIDATE_CHANNEL, JSON.stringify(paths));
  } catch (error) {
    logger.warn(`Document cache invalidation not published: ${(error as Error).message}`);
  }
}

/** Applies invalidations other processes publish. Needs a connected Redis. */
export async function subscribeDocumentInvalidation(): Promise<void> {
  if (subscribed) return;
  const subscriber = redis.getSubscriber();
  if (!subscriber) return;
  subscribed = true;
  subscriber.on('message', (channel: string, message: string) => {
    if (!channel.endsWith(INVALIDATE_CHANNEL)) return;
    try {
      const paths = JSON.parse(message);
      if (Array.isArray(paths)) invalidateLocal(paths.filter((p): p is string => typeof p === 'string'));
    } catch { /* malformed message */ }
  });
  await subscriber.subscribe(INVALIDATE_CHANNEL);
}

/** Paths whose documents show a local post: the Note, its collections, its page, its author's collections. */
export function postDocumentPaths(postId: string, username: string | null | undefined): string[] {
  const paths = [`/posts/${postId}`];
  if (username) paths.push(`/@${username}`, `/users/${username}`);
  return paths;
}

/** Paths whose documents show a local account: actor, collections, pages, WebFinger. */
export function accountDocumentPaths(username: string): string[] {
  return [`/users/${username}`, `/@${username}`, '/.well-known/webfinger'];
}

/** Entries and body bytes held, for tests. */
export function documentCacheSize(): { entries: number; bytes: number } {
  return { entries: store.size, bytes: storedBytes };
}

/** Empties the cache, for tests. */
export function clearDocumentCache(): void {
  store.clear();
  inflight.clear();
  invalidatedAt.clear();
  storedBytes = 0;
}
