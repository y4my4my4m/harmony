/**
 * Mention Resolver
 * 
 * Resolves mention userIds from origin-instance UUIDs to local UUIDs
 * so that the frontend's DisplayName component can resolve display names
 * from the profile cache.
 * 
 * Uses a short-lived in-process cache to avoid redundant DB lookups when
 * multiple messages mentioning the same users arrive in quick succession.
 */

import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';

interface ResolvedProfile {
  id: string;
  displayName?: string;
}

const CACHE_TTL_MS = 60_000; // 1 minute
const profileCache = new Map<string, { profile: ResolvedProfile; expiresAt: number }>();

function getCached(key: string): ResolvedProfile | undefined {
  const entry = profileCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    profileCache.delete(key);
    return undefined;
  }
  return entry.profile;
}

function setCache(key: string, profile: ResolvedProfile): void {
  profileCache.set(key, { profile, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Resolve mention userIds in a structured content array to local profile UUIDs.
 * 
 * Batches all mentions in a single message into at most 2 DB queries
 * (local + remote), with a 60s in-process cache to avoid repeated lookups
 * for the same users across messages.
 * 
 * Only runs at ingestion time - stored content has correct local UUIDs,
 * so the frontend never needs to re-resolve.
 */
export async function resolveMentionUserIds(content: any[]): Promise<any[]> {
  if (!Array.isArray(content)) return content;

  const mentions = content.filter(
    (part: any) => part.type === 'mention' && part.username
  );

  if (mentions.length === 0) return content;

  const localDomain = config.INSTANCE_DOMAIN;
  const resolvedMap = new Map<string, ResolvedProfile>();

  // Separate mentions into cached vs uncached
  const uncachedLocalUsernames: string[] = [];
  const uncachedRemoteFederatedIds: string[] = [];

  for (const m of mentions) {
    const domain = m.domain;
    const username = (m.username || '').replace(/^@+/, '');
    if (!username) continue;

    const isLocal = !domain || domain === localDomain;
    const cacheKey = isLocal
      ? `local:${username.toLowerCase()}`
      : `remote:https://${domain}/users/${username}`.toLowerCase();

    const cached = getCached(cacheKey);
    if (cached) {
      resolvedMap.set(cacheKey, cached);
    } else if (isLocal) {
      uncachedLocalUsernames.push(username);
    } else {
      uncachedRemoteFederatedIds.push(`https://${domain}/users/${username}`);
    }
  }

  // Only query DB for uncached mentions
  if (uncachedLocalUsernames.length > 0) {
    const supabase = getSupabaseClient();
    const { data: localProfiles } = await supabase
      .from('profiles')
      .select('id, username, display_name')
      .in('username', uncachedLocalUsernames)
      .eq('is_local', true);

    if (localProfiles) {
      for (const p of localProfiles) {
        const key = `local:${p.username.toLowerCase()}`;
        const profile: ResolvedProfile = {
          id: p.id,
          displayName: p.display_name || undefined,
        };
        setCache(key, profile);
        resolvedMap.set(key, profile);
      }
    }
  }

  if (uncachedRemoteFederatedIds.length > 0) {
    const supabase = getSupabaseClient();
    const { data: remoteProfiles } = await supabase
      .from('profiles')
      .select('id, username, display_name, federated_id')
      .in('federated_id', uncachedRemoteFederatedIds);

    if (remoteProfiles) {
      for (const p of remoteProfiles) {
        if (p.federated_id) {
          const key = `remote:${p.federated_id.toLowerCase()}`;
          const profile: ResolvedProfile = {
            id: p.id,
            displayName: p.display_name || undefined,
          };
          setCache(key, profile);
          resolvedMap.set(key, profile);
        }
      }
    }
  }

  // Apply resolved UUIDs to content
  return content.map((part: any) => {
    if (part.type !== 'mention' || !part.username) return part;

    const username = (part.username || '').replace(/^@+/, '');
    const domain = part.domain;
    const isLocal = !domain || domain === localDomain;

    const cacheKey = isLocal
      ? `local:${username.toLowerCase()}`
      : `remote:https://${domain}/users/${username}`.toLowerCase();

    const resolved = resolvedMap.get(cacheKey);

    if (resolved) {
      return {
        ...part,
        userId: resolved.id,
        isLocal,
      };
    }

    return { ...part, isLocal };
  });
}
