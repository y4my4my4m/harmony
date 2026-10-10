/**
 * Remote users a local post mentions, resolved to stored profiles at delivery.
 *
 * The composer stores a mention of an account this instance has not seen as a
 * part with userId `unresolved-<user>@<host>`. Such a handle is resolved here
 * through WebFinger (resolveRemoteAccount), which stores the profile, so the
 * Note's Mention tag carries the real actor id and the mentionee's inbox
 * receives the activity.
 */

import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';
import { isValidHost } from '../utils/mentionGrammar.js';
import { pgrstOrValue } from '../utils/postgrestFilter.js';
import { BlockedInstancesCache } from '../services/BlockedInstancesCache.js';

/** Upper bound on WebFinger resolutions per post. */
const MAX_RESOLUTIONS = 10;

export interface MentionHandle {
  username: string;
  /** Lowercased host. */
  domain: string;
}

export interface MentionRecipient {
  id: string;
  federated_id: string | null;
  /** Personal inbox. */
  inbox: string;
}

export function handleKey(username: string, domain: string): string {
  return `${username.toLowerCase()}@${domain.toLowerCase()}`;
}

/**
 * Remote user mentions of `content`, one per handle. Bridged Discord mentions
 * and this instance's own host are excluded.
 */
export function remoteMentionHandles(content: unknown): MentionHandle[] {
  if (!Array.isArray(content)) return [];
  const localHost = String(config.INSTANCE_DOMAIN || '').toLowerCase();
  const out = new Map<string, MentionHandle>();
  for (const part of content) {
    if (part?.type !== 'mention' || part.isLocal || part.isBridged) continue;
    if (typeof part.username !== 'string' || typeof part.domain !== 'string') continue;
    const username = part.username.replace(/^@+/, '');
    const domain = part.domain.toLowerCase();
    if (!username || !domain || domain === localHost || domain === 'discord.com' || !isValidHost(domain)) continue;
    const key = handleKey(username, domain);
    if (!out.has(key)) out.set(key, { username, domain });
  }
  return [...out.values()];
}

/** Handles carried in a job payload; malformed entries are dropped. */
export function payloadMentionHandles(value: unknown): MentionHandle[] | null {
  if (!Array.isArray(value)) return null;
  return remoteMentionHandles(value.map((entry: any) => ({
    type: 'mention',
    username: entry?.username,
    domain: entry?.domain,
    isLocal: false,
  })));
}

/**
 * Stored profiles of `handles`, keyed by handleKey. A handle absent from
 * profiles, or stored without an inbox, is resolved through WebFinger; one
 * that does not resolve is left out.
 */
export async function resolveMentionRecipients(handles: MentionHandle[]): Promise<Map<string, MentionRecipient>> {
  const recipients = new Map<string, MentionRecipient>();
  if (handles.length === 0) return recipients;

  const orFilter = handles
    .map((h) => `and(username.eq.${pgrstOrValue(h.username)},domain.eq.${pgrstOrValue(h.domain)})`)
    .join(',');
  const { data: stored } = await getSupabaseClient()
    .from('profiles')
    .select('id, username, domain, federated_id, inbox_url, is_local')
    .or(orFilter);

  for (const row of stored || []) {
    if (row.is_local || !row.inbox_url) continue;
    recipients.set(handleKey(row.username, String(row.domain)), {
      id: row.id,
      federated_id: row.federated_id || null,
      inbox: row.inbox_url,
    });
  }

  const missing = handles
    .filter((h) => !recipients.has(handleKey(h.username, h.domain)))
    .filter((h) => !BlockedInstancesCache.isBlocked(h.domain))
    .slice(0, MAX_RESOLUTIONS);
  if (missing.length === 0) return recipients;

  const { resolveRemoteAccount } = await import('./ActorService.js');
  await Promise.all(missing.map(async (h) => {
    try {
      const result = await resolveRemoteAccount(h.username, h.domain);
      if (!result.ok || !result.user?.inbox_url) {
        logger.info(`Mention @${h.username}@${h.domain} does not resolve`);
        return;
      }
      recipients.set(handleKey(h.username, h.domain), {
        id: result.user.id,
        federated_id: result.user.federated_id || null,
        inbox: result.user.inbox_url,
      });
      logger.info(`Resolved mention @${h.username}@${h.domain} to ${result.user.federated_id}`);
    } catch (err) {
      logger.warn(`Mention @${h.username}@${h.domain} resolution failed:`, err);
    }
  }));

  return recipients;
}

/**
 * `content` with each remote mention's userId set to its resolved profile id;
 * resolveMentionActorUrls then finds the actor id for the Mention tag.
 */
export function withResolvedMentionIds(content: unknown, recipients: Map<string, MentionRecipient>): unknown {
  if (!Array.isArray(content) || recipients.size === 0) return content;
  return content.map((part: any) => {
    if (part?.type !== 'mention' || part.isLocal || typeof part.username !== 'string' || typeof part.domain !== 'string') {
      return part;
    }
    const recipient = recipients.get(handleKey(part.username.replace(/^@+/, ''), part.domain));
    return recipient && part.userId !== recipient.id ? { ...part, userId: recipient.id } : part;
  });
}
