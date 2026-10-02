/**
 * Receiving software of a remote instance, as the encoding family of favourites and emoji
 * reactions sent to it. See postEngagement.ts for what each family receives.
 *
 * federated_instances.software is shared by every process. A value without
 * metadata.software_source is an admin's and is used as is. Otherwise NodeInfo
 * (/.well-known/nodeinfo, schema 2.0 or 2.1, software.name) is read again once
 * NODEINFO_TTL_MS has passed since an answer, or NODEINFO_RETRY_MS since a failed attempt or
 * over a document's answer. Without a NodeInfo answer the software comes from actor and
 * object documents (detectSoftwareFromDocument): those this process fetches, reported
 * through noteDocumentSoftware, and ap_actor_cache rows for the host. Writes go through
 * record_instance_software. Each process caches an answer for CACHE_TTL_MS.
 */

import { getSupabaseClient } from '../config/supabase.js';
import { safeFetch } from '../utils/ssrfProtection.js';
import { logger } from '../utils/logger.js';

export type EngagementFamily = 'mastodon' | 'misskey' | 'emojiReact';

/** One favourite per account and status; any Undo Like removes it; no emoji reactions. */
const MASTODON_FAMILY = new Set(['mastodon', 'glitch-soc', 'hometown', 'gotosocial']);

/** One reaction per account and note; any Like replaces it, any Undo deletes it. */
const MISSKEY_FAMILY = new Set([
  'misskey', 'sharkey', 'firefish', 'calckey', 'foundkey', 'iceshrimp', 'cherrypick',
  'catodon', 'meisskey', 'magnetar',
]);

/** NodeInfo software.name, compared lowercased. Unknown software is FEP-c0e0 EmojiReact. */
export function engagementFamily(software: string | null | undefined): EngagementFamily {
  const name = (software ?? '').trim().toLowerCase();
  if (MASTODON_FAMILY.has(name)) return 'mastodon';
  if (MISSKEY_FAMILY.has(name)) return 'misskey';
  return 'emojiReact';
}

const CACHE_TTL_MS = 3600_000;
const NODEINFO_TTL_MS = 7 * 24 * 3600_000;
const NODEINFO_RETRY_MS = 6 * 3600_000;
const NODEINFO_TIMEOUT_MS = 5_000;
const CACHED_ACTORS_READ = 5;

const cache = new Map<string, { software: string | null; expires: number }>();
const inFlight = new Map<string, Promise<string | null>>();
const reported = new Map<string, { software: string; expires: number }>();

/** Drops the cached software of one host, or of all. */
export function forgetInstanceSoftware(host?: string): void {
  if (host) {
    cache.delete(host.toLowerCase());
    reported.delete(host.toLowerCase());
  } else {
    cache.clear();
    reported.clear();
  }
}

/** `_misskey_` keys Harmony and other software emit for compatibility; not evidence. */
const BORROWED_MISSKEY_KEYS = new Set(['_misskey_quote', '_misskey_reaction']);

/** Context terms and keys only Misskey and its forks write. */
const MISSKEY_MARKERS = ['isCat', '_misskey_content', '_misskey_summary', '_misskey_votes',
  '_misskey_followedMessage', '_misskey_requireSigninToViewContents', '_misskey_license'];

/**
 * Software named by an actor or object document's @context and keys, or null.
 *   Pleroma, Akkoma   the litepub-0.1 context; Akkoma adds smithereen.software/ns or the
 *                     FEP-2c59 webfinger context (utils.ex make_json_ld_header)
 *   GoToSocial        gotosocial.org/ns
 *   Misskey family    isCat or a Misskey-only `_misskey_` term; joinsharkey.org/ns and
 *                     joinfirefish.org/ns name the fork (misc/contexts.ts)
 *   Mastodon          joinmastodon.org/ns with featuredTags, indexable, memorial,
 *                     attributionDomains or the ostatus namespace
 * `_misskey_quote` and `_misskey_reaction` are written by Harmony and others and decide
 * nothing.
 */
export function detectSoftwareFromDocument(doc: unknown): string | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  let context: string;
  try {
    context = JSON.stringify(d['@context'] ?? '');
  } catch {
    return null;
  }
  const has = (s: string) => context.includes(s);
  const nested = d.object && typeof d.object === 'object' ? Object.keys(d.object as object) : [];
  const keys = [...Object.keys(d), ...nested];

  if (has('litepub')) {
    return has('smithereen.software/ns') || has('purl.archive.org/socialweb/webfinger') ? 'akkoma' : 'pleroma';
  }
  if (has('gotosocial.org/ns')) return 'gotosocial';

  const misskeyKey = keys.some((k) => k === 'isCat' || (k.startsWith('_misskey_') && !BORROWED_MISSKEY_KEYS.has(k)));
  const misskeyTerm = has('misskey-hub.net/ns') && MISSKEY_MARKERS.some((m) => has(`"${m}"`));
  if (misskeyKey || misskeyTerm) {
    if (has('joinsharkey.org/ns')) return 'sharkey';
    if (has('joinfirefish.org/ns')) return 'firefish';
    return 'misskey';
  }

  if (has('joinmastodon.org/ns')
      && ['"featuredTags"', '"indexable"', '"memorial"', '"attributionDomains"', 'ostatus.org'].some(has)) {
    return 'mastodon';
  }
  return null;
}

function hostnameOf(host: string): string {
  try {
    return new URL(`https://${host}`).hostname;
  } catch {
    return host;
  }
}

async function recordSoftware(
  host: string,
  software: string | null,
  version: string | null,
  source: 'nodeinfo' | 'document',
): Promise<string | null | undefined> {
  const { data, error } = await getSupabaseClient().rpc('record_instance_software', {
    p_domain: host,
    p_software: software,
    p_version: version,
    p_source: source,
  });
  if (error) {
    logger.debug(`record_instance_software(${host}, ${source}) failed: ${error.message}`);
    return undefined;
  }
  return typeof data === 'string' && data ? data : null;
}

/**
 * Reports a document served from `url`, or pushed by the actor `url` names. Only the first
 * sighting of a software per host per CACHE_TTL_MS is written.
 */
export function noteDocumentSoftware(url: string, doc: unknown): void {
  let software: string | null;
  let key: string;
  try {
    software = detectSoftwareFromDocument(doc);
    key = new URL(url).host.toLowerCase();
  } catch {
    return;
  }
  if (!software || !key) return;
  const now = Date.now();
  const seen = reported.get(key);
  if (seen && seen.software === software && seen.expires > now) return;
  reported.set(key, { software, expires: now + CACHE_TTL_MS });

  recordSoftware(key, software, null, 'document')
    .then((stored) => {
      if (stored !== undefined) cache.set(key, { software: stored, expires: Date.now() + CACHE_TTL_MS });
    })
    .catch((err) => logger.debug(`Recording the software of ${key} failed: ${(err as Error)?.message ?? err}`));
}

async function fetchNodeinfoSoftware(host: string): Promise<{ name: string; version?: string } | null> {
  try {
    const wellKnown = await safeFetch(`https://${host}/.well-known/nodeinfo`, {
      headers: { Accept: 'application/json' },
      timeoutMs: NODEINFO_TIMEOUT_MS,
    });
    if (!wellKnown.ok) return null;
    const links = (await wellKnown.json())?.links;
    if (!Array.isArray(links)) return null;
    const href = links.find((l: any) =>
      typeof l?.rel === 'string' && /nodeinfo\.diaspora\.software\/ns\/schema\/2\.[01]$/.test(l.rel))?.href;
    if (typeof href !== 'string') return null;

    // The href is remote input; safeFetch validates every hop.
    const nodeinfo = await safeFetch(href, {
      headers: { Accept: 'application/json' },
      timeoutMs: NODEINFO_TIMEOUT_MS,
    });
    if (!nodeinfo.ok) return null;
    const software = (await nodeinfo.json())?.software;
    if (typeof software?.name !== 'string' || !software.name.trim()) return null;
    return { name: software.name.trim().toLowerCase(), version: typeof software.version === 'string' ? software.version : undefined };
  } catch (err) {
    logger.debug(`NodeInfo lookup failed for ${host}: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

/** Software named by the newest cached actor documents of the host. */
async function softwareFromCachedActors(host: string): Promise<string | null> {
  const { data } = await getSupabaseClient()
    .from('ap_actor_cache')
    .select('actor_data')
    .eq('domain', hostnameOf(host))
    .order('last_fetched_at', { ascending: false })
    .limit(CACHED_ACTORS_READ);
  for (const row of data ?? []) {
    const software = detectSoftwareFromDocument(row?.actor_data);
    if (software) return software;
  }
  return null;
}

async function lookupSoftware(host: string): Promise<string | null> {
  const supabase = getSupabaseClient();
  const { data: row } = await supabase
    .from('federated_instances')
    .select('software, metadata')
    .eq('domain', host)
    .maybeSingle();

  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const raw = typeof row?.software === 'string' ? row.software.trim().toLowerCase() : '';
  const stored = raw && raw !== 'unknown' ? raw : null;
  const source = typeof meta.software_source === 'string' ? meta.software_source : null;
  if (stored && !source) return stored;

  const checkedAt = Date.parse(meta.software_checked_at ?? '') || 0;
  const age = Date.now() - checkedAt;
  const due = source === 'nodeinfo' && stored ? age > NODEINFO_TTL_MS : age > NODEINFO_RETRY_MS;

  let current = stored;
  if (due) {
    const fetched = await fetchNodeinfoSoftware(host);
    const recorded = await recordSoftware(host, fetched?.name ?? null, fetched?.version ?? null, 'nodeinfo');
    current = recorded === undefined ? (fetched?.name ?? stored) : recorded;
    if (fetched) return current;
  }
  if (current && source === 'nodeinfo') return current;

  const detected = await softwareFromCachedActors(host);
  if (detected && detected !== current) {
    const recorded = await recordSoftware(host, detected, null, 'document');
    return recorded === undefined ? detected : recorded;
  }
  return current;
}

/** Software name of `host` (URL host, lowercased), or null when unknown. */
export async function instanceSoftware(host: string): Promise<string | null> {
  const key = host.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.software;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = lookupSoftware(key)
      .catch((err) => {
        logger.debug(`Software lookup failed for ${key}: ${(err as Error)?.message ?? err}`);
        return null;
      })
      .then((software) => {
        cache.set(key, { software, expires: Date.now() + CACHE_TTL_MS });
        inFlight.delete(key);
        return software;
      });
    inFlight.set(key, pending);
  }
  return pending;
}

export async function instanceEngagementFamily(host: string): Promise<EngagementFamily> {
  return engagementFamily(await instanceSoftware(host));
}
