/**
 * Server directories of other instances, read for this instance's users.
 *
 * A directory is the OrderedCollection of Group actors a NodeInfo 2.x document names in
 * metadata.serverDirectory (activitypub/serverDirectory.ts publishes this instance's):
 *
 *   https://<domain>/.well-known/nodeinfo -> NodeInfo -> metadata.serverDirectory
 *     -> OrderedCollection -> first page -> orderedItems (Groups)
 *
 * Every fetch goes through safeFetch (SSRF guard, timeout, body cap); NodeInfo and the
 * collection are fetched signed by the instance actor, as instances in authorized fetch mode
 * require. The directory and its pages are on the domain asked for, and so is every Group kept;
 * a Group is kept only when it says `discoverable: true` and neither harmony:public nor
 * harmony:federationEnabled is false. Blocked instances (federated_instances.is_blocked,
 * blocked_instances, subdomains included) and Groups this instance blocks are never read or
 * shown.
 *
 * Answers are cached CACHE_TTL_S; a domain's directory URL DIRECTORY_URL_TTL_S, or
 * NO_DIRECTORY_TTL_S when it names none. Each NodeInfo read is stored on the domain's existing
 * federated_instances row (record_instance_directory), which lists the peers that publish one.
 */

import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { cache } from '../utils/cache.js';
import { safeFetch, validateExternalHostname } from '../utils/ssrfProtection.js';
import { readApDocument, urlHost } from '../utils/apOrigin.js';
import { decodeHtmlEntities } from '../utils/contentUtils.js';
import { SignatureService } from '../activitypub/SignatureService.js';
import { HARMONY_PUBLIC } from '../activitypub/serverDirectory.js';
import { BlockedInstancesCache } from './BlockedInstancesCache.js';

const NODEINFO_TIMEOUT_MS = 5_000;
const DIRECTORY_TIMEOUT_MS = 8_000;
const NODEINFO_MAX_BYTES = 256 * 1024;
const DIRECTORY_MAX_BYTES = 1024 * 1024;
const CACHE_TTL_S = 120;
const DIRECTORY_URL_TTL_S = 600;
const NO_DIRECTORY_TTL_S = 120;

/** Groups kept from one page. */
const MAX_ITEMS = 40;
const MAX_NAME = 100;
const MAX_SUMMARY = 500;
const MAX_URL = 2048;

/** Peers listed, and NodeInfo reads one listing starts. */
const PEER_LIMIT = 50;
const PEER_REFRESH_BATCH = 5;
/** A peer's directory is read again this long after the last read. */
const PEER_RECHECK_MS = 24 * 3600_000;
/** Peers seen within this window are refreshed. */
const PEER_ACTIVE_MS = 30 * 24 * 3600_000;

export interface RemoteDirectoryEntry {
  /** Group actor id; joined through POST /servers/join. */
  id: string;
  name: string;
  summary: string;
  icon: string | null;
  memberCount: number | null;
  /** preferredUsername@domain, the handle Join by URL resolves through WebFinger. */
  handle: string | null;
  category: string | null;
}

export interface RemoteDirectoryPage {
  domain: string;
  directory: string;
  items: RemoteDirectoryEntry[];
  totalItems: number | null;
  /** Next page on the same domain; null at the end. */
  next: string | null;
}

export interface DirectoryPeer {
  domain: string;
  software: string | null;
  icon: string | null;
}

export type DirectoryLookup =
  | { status: 'found'; url: string }
  | { status: 'none' }
  | { status: 'unreachable' };

/** `host[:port]`, lowercased, from a domain or URL; null for anything else. */
export function normalizeDirectoryDomain(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let raw = input.trim().toLowerCase();
  if (!raw || raw.length > 260) return null;
  // :443 is the scheme's default port: URL.host leaves it out.
  raw = raw.replace(/^https?:\/\//, '').split(/[/?#]/)[0].replace(/\.$/, '').replace(/:443$/, '');
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  if (!new RegExp(`^${label}(?:\\.${label})*(?::\\d{1,5})?$`).test(raw)) return null;
  // Any other port would let a caller probe arbitrary services of a public host.
  if (/:\d+$/.test(raw) && !config.DIRECTORY_ALLOW_PORTS) return null;
  return raw.length <= 253 ? raw : null;
}

function hostnameOf(domain: string): string {
  return domain.replace(/:\d+$/, '');
}

/** The domain and each parent: a block of example.com covers a.example.com. */
function domainSuffixes(hostname: string): string[] {
  const parts = hostname.split('.');
  return parts.map((_, i) => parts.slice(i).join('.')).filter((d) => d.includes('.') || d === hostname);
}

/** `domain` is this instance's own. */
export function isOwnDomain(domain: string): boolean {
  const own = config.INSTANCE_DOMAIN.toLowerCase();
  return domain === own || hostnameOf(domain) === own;
}

/** The domain or a parent is blocked here. A failed read counts as not blocked; the cache still applies. */
export async function domainBlockedHere(domain: string): Promise<boolean> {
  const hostname = hostnameOf(domain);
  if (BlockedInstancesCache.isBlocked(hostname)) return true;
  const candidates = [...new Set([domain, ...domainSuffixes(hostname)])];
  const supabase = getSupabaseClient();
  const [instances, blocks] = await Promise.all([
    supabase.from('federated_instances').select('domain').in('domain', candidates).eq('is_blocked', true).limit(1),
    supabase.from('blocked_instances').select('domain').in('domain', candidates).limit(1),
  ]);
  if (instances.error || blocks.error) {
    logger.warn(`Blocks of ${domain} not read: ${instances.error?.message ?? blocks.error?.message}`);
  }
  return (instances.data?.length ?? 0) > 0 || (blocks.data?.length ?? 0) > 0;
}

/** An http(s) URL on `domain`: https, or http outside production. */
function urlOnDomain(value: unknown, domain: string): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL || urlHost(value) !== domain) return null;
  const protocol = new URL(value).protocol;
  return protocol === 'https:' || (protocol === 'http:' && config.NODE_ENV !== 'production') ? value : null;
}

function linkOf(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) return (value as { id?: unknown }).id;
  return value;
}

function isType(doc: any, type: string): boolean {
  const t = doc?.type;
  return t === type || (Array.isArray(t) && t.includes(type));
}

function plainText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = decodeHtmlEntities(value.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n').replace(/<[^>]*>/g, ''))
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function iconUrl(icon: unknown): string | null {
  const first = Array.isArray(icon) ? icon[0] : icon;
  const url = typeof first === 'string' ? first : (first as { url?: unknown } | null)?.url;
  const href = typeof url === 'string' ? url : (url as { href?: unknown } | null)?.href;
  if (typeof href !== 'string' || href.length > MAX_URL || urlHost(href) === null) return null;
  const protocol = new URL(href).protocol;
  return protocol === 'https:' || (protocol === 'http:' && config.NODE_ENV !== 'production') ? href : null;
}

/** A directory item as shown, or null when it is not a listed Group on `domain`. */
export function directoryEntry(item: any, domain: string): RemoteDirectoryEntry | null {
  if (!item || typeof item !== 'object' || !isType(item, 'Group')) return null;
  const id = urlOnDomain(item.id, domain);
  if (!id) return null;
  if (item.discoverable !== true) return null;
  if (item[HARMONY_PUBLIC] === false || item['harmony:federationEnabled'] === false) return null;
  if (item['harmony:suspended']) return null;

  const username = typeof item.preferredUsername === 'string' && /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(item.preferredUsername)
    ? item.preferredUsername
    : null;
  const name = plainText(item.name, MAX_NAME) || username;
  if (!name) return null;
  const count = item['harmony:memberCount'] ?? item.memberCount;
  const category = item['harmony:category'];
  return {
    id,
    name,
    summary: plainText(item.summary, MAX_SUMMARY),
    icon: iconUrl(item.icon),
    memberCount: typeof count === 'number' && Number.isFinite(count) && count >= 0 ? Math.floor(count) : null,
    handle: username ? `${username}@${domain}` : null,
    category: typeof category === 'string' && /^[a-z_]{1,32}$/.test(category) ? category : null,
  };
}

/** NodeInfo 2.1 or 2.0 of `domain`: null when it publishes none, undefined when it did not answer. */
export async function fetchNodeinfo(domain: string): Promise<any | null | undefined> {
  try {
    const wellKnown = await safeFetch(`https://${domain}/.well-known/nodeinfo`, {
      headers: { Accept: 'application/json' },
      timeoutMs: NODEINFO_TIMEOUT_MS,
      maxBodyBytes: NODEINFO_MAX_BYTES,
    });
    if (!wellKnown.ok) return wellKnown.status === 404 ? null : undefined;
    const links = (await wellKnown.json())?.links;
    if (!Array.isArray(links)) return null;
    const href = (['2.1', '2.0'] as const)
      .map((v) => links.find((l: any) => typeof l?.rel === 'string'
        && l.rel.endsWith(`nodeinfo.diaspora.software/ns/schema/${v}`))?.href)
      .find((h) => typeof h === 'string');
    if (typeof href !== 'string') return null;
    const nodeinfo = await SignatureService.signedApFetch(href, {
      headers: { Accept: 'application/json' },
      timeoutMs: NODEINFO_TIMEOUT_MS,
      maxBodyBytes: NODEINFO_MAX_BYTES,
    });
    if (!nodeinfo.ok) return undefined;
    return await nodeinfo.json();
  } catch (err) {
    logger.debug(`NodeInfo of ${domain} not read: ${(err as Error)?.message ?? err}`);
    return undefined;
  }
}

async function recordDirectory(domain: string, url: string | null): Promise<void> {
  const { error } = await getSupabaseClient().rpc('record_instance_directory', { p_domain: domain, p_directory: url });
  if (error) logger.debug(`record_instance_directory(${domain}) failed: ${error.message}`);
}

/** The directory `domain`'s NodeInfo names. */
export async function lookupDirectory(domain: string, opts: { fresh?: boolean } = {}): Promise<DirectoryLookup> {
  const key = `srvdir:url:${domain}`;
  if (!opts.fresh) {
    const hit = await cache.getAsync<DirectoryLookup>(key);
    if (hit) return hit;
  }
  const nodeinfo = await fetchNodeinfo(domain);
  if (nodeinfo === undefined) return { status: 'unreachable' };
  const url = urlOnDomain(nodeinfo?.metadata?.serverDirectory, domain);
  const answer: DirectoryLookup = url ? { status: 'found', url } : { status: 'none' };
  cache.set(key, answer, url ? DIRECTORY_URL_TTL_S : NO_DIRECTORY_TTL_S);
  await recordDirectory(domain, url);
  return answer;
}

async function fetchCollectionDoc(url: string, domain: string): Promise<any | null> {
  try {
    const response = await SignatureService.signedApFetch(url, {
      timeoutMs: DIRECTORY_TIMEOUT_MS,
      maxBodyBytes: DIRECTORY_MAX_BYTES,
    });
    const fetched = await readApDocument(response, url);
    if (!fetched || urlHost(fetched.finalUrl) !== domain || urlHost(fetched.doc?.id) !== domain) return null;
    return fetched.doc;
  } catch (err) {
    logger.debug(`Directory page ${url} not read: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

/** Ids of Groups whose copy this instance blocks. */
async function groupsBlockedHere(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const supabase = getSupabaseClient();
  const { data: copies } = await supabase
    .from('servers')
    .select('id, ap_id')
    .in('ap_id', ids)
    .eq('is_local_server', false);
  const byId = new Map((copies ?? []).map((c: any) => [c.id as string, c.ap_id as string]));
  if (byId.size === 0) return new Set();
  const { data: blocks } = await supabase
    .from('instance_server_blocks')
    .select('server_id')
    .in('server_id', [...byId.keys()])
    .eq('blocked', true);
  return new Set((blocks ?? []).map((b: any) => byId.get(b.server_id)).filter((v): v is string => !!v));
}

/**
 * One page of the directory at `url` on `domain`: the collection's first page, or the page at
 * `url` itself. Null when it cannot be read.
 */
export async function readDirectoryPage(domain: string, directory: string, url: string): Promise<RemoteDirectoryPage | null> {
  const key = `srvdir:page:${url}`;
  const hit = await cache.getAsync<RemoteDirectoryPage>(key);
  if (hit) return hit;

  const doc = await fetchCollectionDoc(url, domain);
  if (!doc) return null;

  let page: any = null;
  let totalItems: number | null = typeof doc.totalItems === 'number' ? doc.totalItems : null;
  if (isType(doc, 'OrderedCollectionPage') || isType(doc, 'CollectionPage')) {
    page = doc;
  } else if (isType(doc, 'OrderedCollection') || isType(doc, 'Collection')) {
    const embedded = doc.orderedItems ?? doc.items;
    if (Array.isArray(embedded)) {
      page = doc;
    } else if (doc.first && typeof doc.first === 'object' && Array.isArray(doc.first.orderedItems ?? doc.first.items)) {
      page = doc.first;
    } else {
      const first = urlOnDomain(linkOf(doc.first), domain);
      page = first ? await fetchCollectionDoc(first, domain) : null;
    }
  }
  if (!page) return null;
  if (totalItems === null && typeof page.totalItems === 'number') totalItems = page.totalItems;

  const raw = page.orderedItems ?? page.items;
  const seen = new Set<string>();
  const entries = (Array.isArray(raw) ? raw : [])
    .slice(0, MAX_ITEMS)
    .map((item: unknown) => directoryEntry(item, domain))
    .filter((e): e is RemoteDirectoryEntry => !!e && !seen.has(e.id) && !!seen.add(e.id));
  const blocked = await groupsBlockedHere(entries.map((e) => e.id));

  const result: RemoteDirectoryPage = {
    domain,
    directory,
    items: entries.filter((e) => !blocked.has(e.id)),
    totalItems,
    next: urlOnDomain(linkOf(page.next), domain),
  };
  cache.set(key, result, CACHE_TTL_S);
  return result;
}

let refreshing: Promise<void> | null = null;

/**
 * Reads the NodeInfo of up to PEER_REFRESH_BATCH peers that run Harmony or published a
 * directory before, seen within PEER_ACTIVE_MS, whose directory was last read PEER_RECHECK_MS
 * ago or never.
 */
export function refreshPeerDirectories(now = Date.now()): Promise<void> {
  refreshing ??= (async () => {
    const { data, error } = await getSupabaseClient()
      .from('federated_instances')
      .select('domain, metadata')
      .or('software.eq.harmony,metadata->>server_directory.not.is.null')
      .not('is_blocked', 'is', true)
      .gte('last_seen_at', new Date(now - PEER_ACTIVE_MS).toISOString())
      .order('last_seen_at', { ascending: false })
      .limit(PEER_LIMIT);
    if (error) {
      logger.warn(`Peers with a directory not read: ${error.message}`);
      return;
    }
    const due = (data ?? [])
      .filter((row: any) => {
        const checked = Date.parse(row.metadata?.directory_checked_at ?? '');
        return !(now - checked < PEER_RECHECK_MS);
      })
      .map((row: any) => normalizeDirectoryDomain(row.domain))
      .filter((d): d is string => !!d && !isOwnDomain(d) && !BlockedInstancesCache.isBlocked(hostnameOf(d)))
      .slice(0, PEER_REFRESH_BATCH);
    await Promise.all(due.map(async (domain) => {
      try {
        validateExternalHostname(hostnameOf(domain));
        await lookupDirectory(domain, { fresh: true });
      } catch (err) {
        logger.debug(`Directory of ${domain} not refreshed: ${(err as Error)?.message ?? err}`);
      }
    }));
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Known instances that publish a directory, most recently seen first. */
export async function listDirectoryPeers(): Promise<DirectoryPeer[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('federated_instances')
    .select('domain, software, metadata')
    .not('metadata->>server_directory', 'is', null)
    .not('is_blocked', 'is', true)
    .order('last_seen_at', { ascending: false, nullsFirst: false })
    .limit(PEER_LIMIT);
  if (error) {
    logger.warn(`Peers with a directory not listed: ${error.message}`);
    return [];
  }
  const rows = (data ?? []) as Array<{ domain: string; software: string | null; metadata: any }>;
  const { data: blocks } = await supabase.from('blocked_instances').select('domain');
  const blockedDomains = new Set((blocks ?? []).map((b: any) => String(b.domain).toLowerCase()));
  return rows
    .map((row) => ({ row, domain: normalizeDirectoryDomain(row.domain) }))
    .filter((r): r is { row: typeof r.row; domain: string } => !!r.domain && !isOwnDomain(r.domain))
    .filter(({ domain }) => {
      const host = hostnameOf(domain);
      return !BlockedInstancesCache.isBlocked(host) && !domainSuffixes(host).some((d) => blockedDomains.has(d));
    })
    .map(({ row, domain }) => ({
      domain,
      software: typeof row.software === 'string' && row.software ? row.software : null,
      icon: iconUrl(row.metadata?.icon_url),
    }));
}
