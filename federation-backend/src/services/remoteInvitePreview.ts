/**
 * Server card of an invite link to another Harmony instance, https://<host>/invite/<code>.
 *
 * <host> runs Harmony when its NodeInfo names the software `harmony`; its name and icon are
 * NodeInfo metadata.nodeName and metadata.icon, the name falling back to the host. The card is
 * the host's answer to GET /api/federation/invites/<code> (ServerDiscoveryService), the answer
 * member instances read before a join:
 *   200                       valid: the server's name, icon, description, member count, online
 *                             count (hosts from 1.9.4) and Group id
 *   404, 410                  invalid: unknown, revoked, expired or used up
 *   403 federation_disabled   closed: the server admits no members from other instances
 * Any other answer, a malformed one, or one served from another host after redirects, is
 * `unavailable`.
 *
 * Every fetch goes through safeFetch (SSRF guard, timeout, body cap). Text is one line of plain
 * text, capped; counts are non-negative integers; URLs are https; the Group id is on the host.
 * Nothing is read while either federation switch is off, or for a host blocked here.
 * Cards are cached CARD_TTL_S (UNAVAILABLE_TTL_S when unavailable); a host's NodeInfo
 * INSTANCE_TTL_S, NO_NODEINFO_TTL_S when it did not answer. Concurrent lookups of one card or
 * one host share one read.
 */

import { cache } from '../utils/cache.js';
import { logger } from '../utils/logger.js';
import { safeFetch, validateExternalHostname } from '../utils/ssrfProtection.js';
import { urlHost } from '../utils/apOrigin.js';
import { isDefaultServerIcon } from '../utils/urlUtils.js';
import { federationUserAgent } from '../utils/userAgent.js';
import { brandingUrl } from '../activitypub/instanceBranding.js';
import { federationSwitches } from './FederationSwitches.js';
import { INVITE_PATH } from './invitePreview.js';
import { domainBlockedHere, fetchNodeinfo, isOwnDomain, normalizeDirectoryDomain } from './RemoteDirectoryService.js';

const CARD_TTL_S = 60;
const UNAVAILABLE_TTL_S = 30;
const INSTANCE_TTL_S = 600;
const NO_NODEINFO_TTL_S = 60;
const INVITE_TIMEOUT_MS = 5_000;
/** The answer lists the channels a member sees; 500 channels are about 100 KB. */
const INVITE_MAX_BYTES = 256 * 1024;

export const MAX_SERVER_NAME = 100;
export const MAX_DESCRIPTION = 300;
export const MAX_INSTANCE_NAME = 100;
const MAX_URL = 2048;

export interface RemoteInviteServer {
  name: string;
  description: string | null;
  icon: string | null;
  memberCount: number | null;
  /** Null from hosts before 1.9.4. */
  onlineCount: number | null;
  /** The Group's actor id, on the invite's host. */
  id: string | null;
}

/** src/types/chat.ts RemoteInviteSummary. */
export interface RemoteInviteCard {
  status: 'valid' | 'invalid' | 'closed';
  code: string;
  /** host[:port] of the link: the instance hosting the server. */
  domain: string;
  instance: { name: string; icon: string | null };
  /** Valid cards only. */
  server?: RemoteInviteServer;
}

export type RemoteInviteLookup =
  | { status: 'card'; card: RemoteInviteCard }
  /** Not an invite link of another Harmony instance that is read here. */
  | { status: 'none' }
  /** A Harmony host that gave no usable answer. */
  | { status: 'unavailable' };

interface HarmonyInstance {
  name: string;
  icon: string | null;
}

const NONE: RemoteInviteLookup = { status: 'none' };
const UNAVAILABLE: RemoteInviteLookup = { status: 'unavailable' };

const inFlight = new Map<string, Promise<unknown>>();

/** `read` once per key while a read of it is pending. */
function shared<T>(key: string, read: () => Promise<T>): Promise<T> {
  let pending = inFlight.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = read().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/** C0/C1 controls, zero-width characters, bidi embeddings, overrides and isolates. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** One line of plain text of at most `max` code points, or null when nothing is left. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max - 1).join('').trimEnd()}…` : text;
}

/** An https URL without credentials, at most MAX_URL characters; null otherwise. */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Host and code of an https invite link on another instance, or null. */
export function remoteInviteTarget(raw: unknown): { domain: string; code: string } | null {
  if (typeof raw !== 'string' || raw.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const code = INVITE_PATH.exec(url.pathname)?.[1];
  if (!code) return null;
  const domain = normalizeDirectoryDomain(url.host);
  if (!domain || isOwnDomain(domain)) return null;
  return { domain, code };
}

/** Name and icon of `domain` when its NodeInfo names Harmony, else null. */
async function harmonyInstance(domain: string): Promise<HarmonyInstance | null> {
  const key = `remote-invite:instance:${domain}`;
  const hit = await cache.getAsync<{ instance: HarmonyInstance | null }>(key);
  if (hit) return hit.instance;

  return shared(key, async () => {
    const nodeinfo = await fetchNodeinfo(domain);
    const software = typeof nodeinfo?.software?.name === 'string' ? nodeinfo.software.name.trim().toLowerCase() : '';
    const instance = software === 'harmony'
      ? {
          name: cleanText(nodeinfo.metadata?.nodeName, MAX_INSTANCE_NAME) ?? domain,
          icon: httpsUrl(brandingUrl(domain, nodeinfo.metadata?.icon)),
        }
      : null;
    cache.set(key, { instance }, nodeinfo === undefined ? NO_NODEINFO_TTL_S : INSTANCE_TTL_S);
    return instance;
  });
}

/** The server of a 200 answer, or null when it names none. */
export function inviteServer(data: any, domain: string): RemoteInviteServer | null {
  const server = data?.server;
  if (!server || typeof server !== 'object' || Array.isArray(server)) return null;
  const name = cleanText(server.name, MAX_SERVER_NAME);
  if (!name) return null;
  const icon = typeof server.icon === 'string' && !isDefaultServerIcon(server.icon) ? httpsUrl(server.icon) : null;
  const id = httpsUrl(server.id);
  return {
    name,
    description: cleanText(server.description, MAX_DESCRIPTION),
    icon,
    memberCount: count(server.memberCount),
    onlineCount: count(server.onlineCount),
    id: id && urlHost(id) === domain ? id : null,
  };
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchCard(domain: string, code: string, instance: HarmonyInstance): Promise<RemoteInviteLookup> {
  let response: Response;
  try {
    response = await safeFetch(`https://${domain}/api/federation/invites/${encodeURIComponent(code)}`, {
      headers: { Accept: 'application/json', 'User-Agent': federationUserAgent() },
      timeoutMs: INVITE_TIMEOUT_MS,
      maxBodyBytes: INVITE_MAX_BYTES,
    });
  } catch (err) {
    logger.debug(`Invite ${code} of ${domain} not read: ${(err as Error)?.message ?? err}`);
    return UNAVAILABLE;
  }
  if (urlHost(response.url) !== domain) {
    await response.body?.cancel().catch(() => {});
    return UNAVAILABLE;
  }

  const card = (status: RemoteInviteCard['status'], server?: RemoteInviteServer): RemoteInviteLookup => ({
    status: 'card',
    card: { status, code, domain, instance, ...(server ? { server } : {}) },
  });

  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel().catch(() => {});
    return card('invalid');
  }
  if (response.status === 403) {
    const refusal = await readJson(response);
    return refusal?.code === 'federation_disabled' ? card('closed') : UNAVAILABLE;
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    return UNAVAILABLE;
  }
  const server = inviteServer(await readJson(response), domain);
  return server ? card('valid', server) : UNAVAILABLE;
}

/** The card of an invite link to another Harmony instance. */
export async function resolveRemoteInvite(raw: unknown): Promise<RemoteInviteLookup> {
  const target = remoteInviteTarget(raw);
  if (!target) return NONE;
  const { domain, code } = target;
  try {
    validateExternalHostname(domain.replace(/:\d+$/, ''));
  } catch {
    return NONE;
  }
  const { inbound, outbound } = await federationSwitches();
  if (!inbound || !outbound) return NONE;
  if (await domainBlockedHere(domain)) return NONE;

  const key = `remote-invite:card:${domain}:${code}`;
  const hit = await cache.getAsync<RemoteInviteLookup>(key);
  if (hit) return hit;

  return shared(key, async () => {
    const instance = await harmonyInstance(domain);
    if (!instance) return NONE;
    const result = await fetchCard(domain, code, instance);
    cache.set(key, result, result.status === 'unavailable' ? UNAVAILABLE_TTL_S : CARD_TTL_S);
    return result;
  });
}
