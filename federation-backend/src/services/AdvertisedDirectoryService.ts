/**
 * Servers advertised across federation by the instances this one knows, merged into one list
 * (GET /directory/servers).
 *
 * The instances are listDirectoryPeers(): federated_instances rows whose NodeInfo names a server
 * directory, neither they nor a parent domain blocked here, this instance left out. Of each, the
 * first page of its directory is read (lookupDirectory, readDirectoryPage: safeFetch, signed by
 * the instance actor, timeouts and body caps, listed Groups on that domain only, Groups blocked
 * here dropped).
 *
 * Each instance's servers are kept FRESH_MS. Past that they are still served, up to STALE_MS
 * after the last good read, while one read runs in the background; a failed read is tried again
 * after RETRY_MS. At most CONCURRENCY instances are read at once, each read whole (NodeInfo,
 * directory, page; headers and bodies) within READ_DEADLINE_MS or aborted and counted as
 * failed. A request waits up to WAIT_MS for the instances it holds nothing of, then answers with
 * the rest: `pending` counts instances still being read, `failed` names those whose directory
 * could not be read.
 *
 * The merged list holds each Group once, Groups blocked here left out. `query` keeps those whose
 * name, summary, handle, category or instance contains it, case and width folded. Member counts
 * are each peer's own claim: every instance's first LEAD_PER_INSTANCE servers come first, then
 * the rest, each part most members first, then by name.
 */

import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { validateExternalHostname } from '../utils/ssrfProtection.js';
import {
  listDirectoryPeers,
  lookupDirectory,
  readDirectoryPage,
  type RemoteDirectoryEntry,
} from './RemoteDirectoryService.js';

export const FRESH_MS = 15 * 60_000;
export const STALE_MS = 6 * 3600_000;
export const RETRY_MS = 2 * 60_000;
export const WAIT_MS = 5_000;
export const CONCURRENCY = 4;
export const READ_DEADLINE_MS = 20_000;
export const LEAD_PER_INSTANCE = 3;

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 60;
const MAX_OFFSET = 2_000;
const MAX_QUERY = 100;

export interface AdvertisedInstance {
  domain: string;
  /** NodeInfo metadata.nodeName; null when it names none. */
  name: string | null;
  icon: string | null;
}

export interface AdvertisedServer extends RemoteDirectoryEntry {
  instance: AdvertisedInstance;
}

export interface AdvertisedPage {
  items: AdvertisedServer[];
  /** Servers matching the query across every instance read. */
  total: number;
  nextOffset: number | null;
  /** Instances whose servers are in the list. */
  instances: number;
  pending: number;
  failed: string[];
}

interface Snapshot {
  servers: RemoteDirectoryEntry[];
  name: string | null;
  icon: string | null;
  /** Last good read, ms since the epoch; 0 before one. */
  readAt: number;
  /** Last attempt, ms since the epoch. */
  checkedAt: number;
  ok: boolean;
}

const snapshots = new Map<string, Snapshot>();
const reading = new Map<string, Promise<void>>();
let active = 0;
const waiters: Array<() => void> = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  while (active >= CONCURRENCY) await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

function due(s: Snapshot | undefined, now: number): boolean {
  return !s || now - s.checkedAt >= (s.ok ? FRESH_MS : RETRY_MS);
}

function usable(s: Snapshot | undefined, now: number): boolean {
  return !!s && s.readAt > 0 && now - s.readAt < STALE_MS;
}

interface InstanceRead {
  servers: RemoteDirectoryEntry[];
  name: string | null;
  icon: string | null;
}

async function readInstance(domain: string, signal: AbortSignal): Promise<InstanceRead | null> {
  try {
    validateExternalHostname(domain.replace(/:\d+$/, ''));
    const lookup = await lookupDirectory(domain, { signal });
    if (lookup.status !== 'found') return null;
    const page = await readDirectoryPage(domain, lookup.url, lookup.url, signal);
    return page ? { servers: page.items, name: lookup.name ?? null, icon: lookup.icon ?? null } : null;
  } catch (err) {
    logger.debug(`Advertised servers of ${domain} not read: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

/** Reads `domain`'s first directory page into its snapshot; one read per domain at a time. */
function refresh(domain: string): Promise<void> {
  const running = reading.get(domain);
  if (running) return running;
  const read = slot(async () => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The race frees the slot when a step ignores the signal (DNS, the database).
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        abort.abort(new Error(`not read within ${READ_DEADLINE_MS} ms`));
        logger.debug(`Advertised servers of ${domain} not read within ${READ_DEADLINE_MS} ms`);
        resolve(null);
      }, READ_DEADLINE_MS);
    });
    const got = await Promise.race([readInstance(domain, abort.signal), deadline]);
    clearTimeout(timer);
    const at = Date.now();
    const previous = snapshots.get(domain);
    snapshots.set(domain, got
      ? { ...got, readAt: at, checkedAt: at, ok: true }
      : { servers: previous?.servers ?? [], name: previous?.name ?? null, icon: previous?.icon ?? null,
          readAt: previous?.readAt ?? 0, checkedAt: at, ok: false });
  }).finally(() => reading.delete(domain));
  reading.set(domain, read);
  return read;
}

/** NFKC, lowercased, trimmed; empty for no query. */
function fold(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('en').trim();
}

function matches(server: AdvertisedServer, query: string): boolean {
  return fold([
    server.name, server.summary, server.handle ?? '', server.category ?? '',
    server.instance.domain, server.instance.name ?? '',
  ].join('\n')).includes(query);
}

function byMembers(a: AdvertisedServer, b: AdvertisedServer): number {
  return (b.memberCount ?? -1) - (a.memberCount ?? -1)
    || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Every instance's first LEAD_PER_INSTANCE by members, then the rest; both by members. */
function ranked(servers: AdvertisedServer[]): AdvertisedServer[] {
  const lead: AdvertisedServer[] = [];
  const rest: AdvertisedServer[] = [];
  const counted = new Map<string, number>();
  for (const server of [...servers].sort(byMembers)) {
    const n = counted.get(server.instance.domain) ?? 0;
    counted.set(server.instance.domain, n + 1);
    (n < LEAD_PER_INSTANCE ? lead : rest).push(server);
  }
  return [...lead, ...rest];
}

/** Group ids of the copies this instance blocks; one query whatever the directories hold. */
async function blockedGroups(): Promise<Set<string>> {
  const { data, error } = await getSupabaseClient()
    .from('instance_server_blocks')
    .select('servers!inner(ap_id)')
    .eq('blocked', true)
    .eq('servers.is_local_server', false);
  if (error) logger.warn(`Blocked copies not read: ${error.message}`);
  return new Set((data ?? []).map((row: any) => row.servers?.ap_id).filter((id): id is string => typeof id === 'string'));
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
}

export function parseAdvertisedQuery(query: Record<string, unknown>): { query: string; offset: number; limit: number } {
  const q = typeof query.q === 'string' ? fold(query.q).slice(0, MAX_QUERY) : '';
  return {
    query: q,
    offset: boundedInt(query.offset, 0, 0, MAX_OFFSET),
    limit: boundedInt(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
  };
}

export async function advertisedServers(opts: { query: string; offset: number; limit: number }): Promise<AdvertisedPage> {
  const peers = await listDirectoryPeers();
  const started = Date.now();
  const awaited: Promise<void>[] = [];
  for (const peer of peers) {
    const snapshot = snapshots.get(peer.domain);
    if (!due(snapshot, started)) continue;
    const read = refresh(peer.domain);
    if (!usable(snapshot, started)) awaited.push(read);
  }
  if (awaited.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(awaited),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, WAIT_MS); }),
    ]);
    clearTimeout(timer);
  }

  const now = Date.now();
  const listed = new Set(peers.map((p) => p.domain));
  for (const [domain, snapshot] of snapshots) {
    if (!listed.has(domain) && !reading.has(domain) && !usable(snapshot, now)) snapshots.delete(domain);
  }

  // A Group blocked since its instance was read.
  const blocked = snapshots.size > 0 ? await blockedGroups() : new Set<string>();
  const merged: AdvertisedServer[] = [];
  const seen = new Set<string>();
  const failed: string[] = [];
  let pending = 0;
  let instances = 0;
  for (const peer of peers) {
    const snapshot = snapshots.get(peer.domain);
    if (!snapshot || !usable(snapshot, now)) {
      if (snapshot && !snapshot.ok && !reading.has(peer.domain)) failed.push(peer.domain);
      else pending++;
      continue;
    }
    instances++;
    const instance: AdvertisedInstance = { domain: peer.domain, name: snapshot.name, icon: snapshot.icon ?? peer.icon };
    for (const server of snapshot.servers) {
      if (seen.has(server.id) || blocked.has(server.id)) continue;
      seen.add(server.id);
      merged.push({ ...server, instance });
    }
  }

  const found = ranked(opts.query ? merged.filter((s) => matches(s, opts.query)) : merged);
  const end = opts.offset + opts.limit;
  return {
    items: found.slice(opts.offset, end),
    total: found.length,
    nextOffset: end < found.length ? end : null,
    instances,
    pending,
    failed,
  };
}
