/**
 * WebFinger (RFC 7033) client, after Mastodon's Webfinger (app/lib/webfinger.rb),
 * ResolveAccountService#process_webfinger! and
 * ActivityPub::FetchRemoteActorService#check_webfinger!.
 *
 * GET https://<domain>/.well-known/webfinger?resource=acct:<user>@<domain>,
 * redirects followed. A 404 falls back to the lrdd template of
 * https://<domain>/.well-known/host-meta (RFC 6415, XRD or JRD).
 *
 * A split-domain instance (Mastodon LOCAL_DOMAIN + WEB_DOMAIN) serves actors
 * on its web domain and names accounts on its account domain: WebFinger on
 * either domain answers with subject acct:<user>@<account domain>. That
 * subject is canonical only when WebFinger for the subject itself names the
 * same subject and the same actor.
 */

import config from '../config/index.js';
import { logger } from '../utils/logger.js';
import { safeFetch } from '../utils/ssrfProtection.js';
import { sameUrl, urlHost } from '../utils/apOrigin.js';

export interface Acct {
  username: string;
  /** Lowercased host[:port]. */
  domain: string;
}

export interface WebFingerDocument {
  subject: Acct | null;
  /** href of the `self` link with an ActivityPub media type. */
  actorUrl: string | null;
}

const WEBFINGER_MAX_BYTES = 256 * 1024;
const AS_PROFILE = 'https://www.w3.org/ns/activitystreams';

function userAgent(): string {
  return `Harmony/${config.VERSION} (+https://${config.INSTANCE_DOMAIN})`;
}

/** `acct:user@domain`, `user@domain` or `@user@domain`; null for anything else. */
export function parseAcct(value: unknown): Acct | null {
  if (typeof value !== 'string') return null;
  const bare = value.trim().replace(/^acct:/i, '').replace(/^@/, '');
  const at = bare.lastIndexOf('@');
  if (at <= 0 || at === bare.length - 1) return null;
  const username = bare.slice(0, at);
  const domain = bare.slice(at + 1).toLowerCase();
  if (/[\s/@?#]/.test(username) || !/^[a-z0-9.-]+(:\d+)?$/.test(domain)) return null;
  return { username, domain };
}

export function sameAcct(a: Acct | null, b: Acct | null): boolean {
  return !!a && !!b && a.domain === b.domain && a.username.toLowerCase() === b.username.toLowerCase();
}

function acctUri(acct: Acct): string {
  return `acct:${acct.username}@${acct.domain}`;
}

function isActivityPubLinkType(type: unknown): boolean {
  if (typeof type !== 'string') return false;
  const mime = type.split(';')[0].trim().toLowerCase();
  return mime === 'application/activity+json' || (mime === 'application/ld+json' && type.includes(AS_PROFILE));
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Attributes of every `<Link>` element of an XRD document. */
function xrdLinks(xml: string): Array<Record<string, string>> {
  const links: Array<Record<string, string>> = [];
  for (const tag of xml.match(/<Link\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([A-Za-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[m[1].toLowerCase()] = decodeXml(m[2] ?? m[3] ?? '');
    }
    links.push(attrs);
  }
  return links;
}

function looksLikeXml(body: string, contentType: string): boolean {
  const head = body.trimStart();
  return contentType.includes('xml') || head.startsWith('<?xml') || head.startsWith('<XRD');
}

/** Subject and ActivityPub `self` link of a JRD or XRD body. */
export function parseWebFinger(body: string, contentType: string): WebFingerDocument | null {
  if (looksLikeXml(body, contentType)) {
    const subject = /<Subject>\s*([^<]+?)\s*<\/Subject>/i.exec(body)?.[1];
    const self = xrdLinks(body).find((l) => l.rel === 'self' && isActivityPubLinkType(l.type) && l.href);
    return { subject: parseAcct(subject ? decodeXml(subject) : null), actorUrl: self?.href ?? null };
  }
  let jrd: any;
  try {
    jrd = JSON.parse(body);
  } catch {
    return null;
  }
  if (!jrd || typeof jrd !== 'object') return null;
  const links = Array.isArray(jrd.links) ? jrd.links : [];
  const self = links.find((l: any) => l?.rel === 'self' && isActivityPubLinkType(l.type) && typeof l.href === 'string');
  return { subject: parseAcct(jrd.subject), actorUrl: self?.href ?? null };
}

/** lrdd template of a host-meta document (XRD or JRD); null when absent. */
export function parseHostMetaTemplate(body: string, contentType: string): string | null {
  if (looksLikeXml(body, contentType)) {
    const lrdd = xrdLinks(body).find((l) => l.rel === 'lrdd' && l.template);
    return lrdd?.template?.includes('{uri}') ? lrdd.template : null;
  }
  try {
    const links = JSON.parse(body)?.links;
    const lrdd = Array.isArray(links)
      ? links.find((l: any) => l?.rel === 'lrdd' && typeof l.template === 'string')
      : null;
    return lrdd?.template?.includes('{uri}') ? lrdd.template : null;
  } catch {
    return null;
  }
}

async function getText(url: string, accept: string, timeoutMs: number): Promise<{ status: number; body: string; contentType: string }> {
  const response = await safeFetch(url, {
    headers: { 'Accept': accept, 'User-Agent': userAgent() },
    timeoutMs,
    maxBodyBytes: WEBFINGER_MAX_BYTES,
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* noop */ }
    return { status: response.status, body: '', contentType };
  }
  return { status: response.status, body: await response.text(), contentType };
}

/** WebFinger answers within one resolution, keyed by acct URI. */
export type WebFingerCache = Map<string, Promise<WebFingerDocument | null>>;

/**
 * WebFinger document for `acct`; null when the endpoint and its host-meta
 * fallback both fail. Never throws.
 */
export function fetchWebFinger(acct: Acct, timeoutMs = 10_000, cache?: WebFingerCache): Promise<WebFingerDocument | null> {
  const key = acctUri(acct).toLowerCase();
  const hit = cache?.get(key);
  if (hit) return hit;
  const pending = fetchWebFingerUncached(acct, timeoutMs);
  cache?.set(key, pending);
  return pending;
}

async function fetchWebFingerUncached(acct: Acct, timeoutMs: number): Promise<WebFingerDocument | null> {
  const resource = encodeURIComponent(acctUri(acct));
  const accept = 'application/jrd+json, application/json, application/xrd+xml;q=0.9';
  try {
    const direct = await getText(`https://${acct.domain}/.well-known/webfinger?resource=${resource}`, accept, timeoutMs);
    if (direct.status === 200) return parseWebFinger(direct.body, direct.contentType);
    if (direct.status !== 404) {
      logger.debug(`WebFinger for ${acctUri(acct)} returned ${direct.status}`);
      return null;
    }

    const hostMeta = await getText(
      `https://${acct.domain}/.well-known/host-meta`,
      'application/xrd+xml, application/xml;q=0.9, application/json;q=0.8',
      timeoutMs,
    );
    if (hostMeta.status !== 200) return null;
    const template = parseHostMetaTemplate(hostMeta.body, hostMeta.contentType);
    if (!template) return null;

    const viaTemplate = await getText(template.replace('{uri}', resource), accept, timeoutMs);
    return viaTemplate.status === 200 ? parseWebFinger(viaTemplate.body, viaTemplate.contentType) : null;
  } catch (err) {
    logger.debug(`WebFinger for ${acctUri(acct)} failed: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

/**
 * Actor URL of `username@domain` (ResolveAccountService#process_webfinger!).
 * A subject on another domain is followed once, and that domain's answer
 * names the actor when it agrees on the subject. The actor's canonical
 * account is decided from the actor side, by confirmActorAcct.
 */
export async function resolveActorUrl(
  username: string,
  domain: string,
  timeoutMs = 10_000,
  cache?: WebFingerCache,
): Promise<{ actorUrl: string; subject: Acct } | null> {
  const queried = parseAcct(`${username}@${domain}`);
  if (!queried) return null;

  const first = await fetchWebFinger(queried, timeoutMs, cache);
  if (!first?.actorUrl || urlHost(first.actorUrl) === null) return null;

  const subject = first.subject ?? queried;
  if (sameAcct(subject, queried)) return { actorUrl: first.actorUrl, subject };

  const second = await fetchWebFinger(subject, timeoutMs, cache);
  if (second?.actorUrl && urlHost(second.actorUrl) !== null && sameAcct(second.subject ?? subject, subject)) {
    return { actorUrl: second.actorUrl, subject };
  }
  return { actorUrl: first.actorUrl, subject: queried };
}

/**
 * Canonical account of an actor (FetchRemoteActorService#check_webfinger!):
 * WebFinger for the actor's FEP-2c59 `webfinger` property, else for
 * preferredUsername at the actor's host, and once more for the subject when
 * that names another account, must link back to the actor id. Null when
 * unconfirmed; the actor's host then stands as its domain.
 */
export async function confirmActorAcct(actor: any, timeoutMs = 5_000, cache?: WebFingerCache): Promise<Acct | null> {
  const host = urlHost(actor?.id);
  if (!host) return null;
  const start = parseAcct(actor.webfinger)
    ?? (typeof actor.preferredUsername === 'string' ? parseAcct(`${actor.preferredUsername}@${host}`) : null);
  if (!start) return null;

  const first = await fetchWebFinger(start, timeoutMs, cache);
  if (!first) return null;
  const subject = first.subject ?? start;
  if (sameAcct(subject, start)) {
    return sameUrl(first.actorUrl, actor.id) ? subject : null;
  }

  const second = await fetchWebFinger(subject, timeoutMs, cache);
  if (second && sameAcct(second.subject ?? subject, subject) && sameUrl(second.actorUrl, actor.id)) {
    return subject;
  }
  logger.info(`WebFinger subject ${acctUri(subject)} does not link back to ${actor.id}`);
  return null;
}

/**
 * Profile fields with the canonical account applied when it is on another
 * domain than the actor's host. On the actor's own host preferredUsername
 * stays the username.
 */
export function withCanonicalAcct<T extends { username: string; domain: string }>(profile: T, acct: Acct | null): T {
  if (!acct || acct.domain === profile.domain.toLowerCase()) return profile;
  return { ...profile, username: acct.username, domain: acct.domain };
}
