import { redis } from './RedisService.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

const PROFILE_TTL = 300; // 5 minutes
const PROFILE_KEY = 'profile';

export interface CachedProfile {
  id: string;
  username: string;
  display_name?: string;
  avatar_url?: string;
  domain: string;
  is_local: boolean;
  federated_id?: string;
  public_key?: string;
  bio?: string;
  color?: string;
  status?: number;
  banner_url?: string;
  followers_count?: number;
  following_count?: number;
  posts_count?: number;
}

const SELECT_FIELDS = 'id, username, display_name, avatar_url, domain, is_local, federated_id, public_key, bio, color, status, banner_url, followers_count, following_count, posts_count';

/**
 * Redis-cached profile lookups.
 *
 * Falls back to direct DB queries when Redis is unavailable.
 * Cache is keyed by multiple access patterns:
 *   - `profile:id:{id}`
 *   - `profile:username:{username}:{domain}`
 *   - `profile:federated:{federated_id}`
 */
class ProfileCacheServiceSingleton {

  private async cacheProfile(profile: CachedProfile): Promise<void> {
    if (!redis.ready) return;
    const json = JSON.stringify(profile);

    const ops: Promise<boolean>[] = [
      redis.set(`${PROFILE_KEY}:id:${profile.id}`, json, PROFILE_TTL),
    ];
    if (profile.username && profile.domain) {
      ops.push(redis.set(`${PROFILE_KEY}:username:${profile.username}:${profile.domain}`, json, PROFILE_TTL));
    }
    if (profile.federated_id) {
      ops.push(redis.set(`${PROFILE_KEY}:federated:${profile.federated_id}`, json, PROFILE_TTL));
    }

    await Promise.all(ops).catch((err) => {
      logger.warn('Profile cache write failed:', err);
    });
  }

  async invalidate(profileId: string): Promise<void> {
    if (!redis.ready) return;

    const raw = await redis.get(`${PROFILE_KEY}:id:${profileId}`);
    if (raw) {
      try {
        const p = JSON.parse(raw) as CachedProfile;
        const keys = [`${PROFILE_KEY}:id:${profileId}`];
        if (p.username && p.domain) keys.push(`${PROFILE_KEY}:username:${p.username}:${p.domain}`);
        if (p.federated_id) keys.push(`${PROFILE_KEY}:federated:${p.federated_id}`);
        await redis.del(...keys);
      } catch {
        await redis.del(`${PROFILE_KEY}:id:${profileId}`);
      }
    }
  }

  async getById(profileId: string): Promise<CachedProfile | null> {
    // Try Redis first
    if (redis.ready) {
      const cached = await redis.getJSON<CachedProfile>(`${PROFILE_KEY}:id:${profileId}`);
      if (cached) return cached;
    }

    // Fallback to DB
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('profiles')
      .select(SELECT_FIELDS)
      .eq('id', profileId)
      .single();

    if (error || !data) return null;

    const profile = data as CachedProfile;
    await this.cacheProfile(profile);
    return profile;
  }

  async getByUsername(username: string, domain: string): Promise<CachedProfile | null> {
    if (redis.ready) {
      const cached = await redis.getJSON<CachedProfile>(`${PROFILE_KEY}:username:${username}:${domain}`);
      if (cached) return cached;
    }

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('profiles')
      .select(SELECT_FIELDS)
      .eq('username', username)
      .eq('domain', domain)
      .single();

    if (error || !data) return null;

    const profile = data as CachedProfile;
    await this.cacheProfile(profile);
    return profile;
  }

  async getByFederatedId(federatedId: string): Promise<CachedProfile | null> {
    if (redis.ready) {
      const cached = await redis.getJSON<CachedProfile>(`${PROFILE_KEY}:federated:${federatedId}`);
      if (cached) return cached;
    }

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('profiles')
      .select(SELECT_FIELDS)
      .eq('federated_id', federatedId)
      .maybeSingle();

    if (error || !data) return null;

    const profile = data as CachedProfile;
    await this.cacheProfile(profile);
    return profile;
  }

  /**
   * Bulk fetch profiles by IDs. Uses pipeline for Redis, falls back to DB.
   */
  async getByIds(profileIds: string[]): Promise<Map<string, CachedProfile>> {
    const result = new Map<string, CachedProfile>();
    if (profileIds.length === 0) return result;

    const missing: string[] = [];

    // Try Redis pipeline
    if (redis.ready) {
      const client = redis.getClient();
      if (client) {
        const pipeline = client.pipeline();
        for (const id of profileIds) {
          pipeline.get(`${PROFILE_KEY}:id:${id}`);
        }
        const responses = await pipeline.exec();
        if (responses) {
          for (let i = 0; i < profileIds.length; i++) {
            const raw = responses[i]?.[1] as string | null;
            if (raw) {
              try {
                result.set(profileIds[i], JSON.parse(raw));
              } catch {
                missing.push(profileIds[i]);
              }
            } else {
              missing.push(profileIds[i]);
            }
          }
        }
      }
    } else {
      missing.push(...profileIds);
    }

    // Fetch missing from DB
    if (missing.length > 0) {
      const supabase = getSupabaseClient();
      const { data } = await supabase
        .from('profiles')
        .select(SELECT_FIELDS)
        .in('id', missing);

      if (data) {
        for (const row of data) {
          const profile = row as CachedProfile;
          result.set(profile.id, profile);
          this.cacheProfile(profile).catch(() => {});
        }
      }
    }

    return result;
  }
}

export const profileCacheService = new ProfileCacheServiceSingleton();
export default profileCacheService;
