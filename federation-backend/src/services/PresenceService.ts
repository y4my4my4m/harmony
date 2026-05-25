import { redis } from './RedisService.js';
import { logger } from '../utils/logger.js';

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline' | 'invisible';

export interface PresenceData {
  status: PresenceStatus;
  customStatus?: string;
  lastSeen: number;
}

const HEARTBEAT_TTL = 120; // seconds - client heartbeats every 60s, 2x grace
const PRESENCE_KEY = 'presence';
const PRESENCE_DETAIL_KEY = 'presence:detail';

/**
 * Redis-backed presence service.
 *
 * Data model:
 *   - Sorted set  `presence`          → member=profileId, score=lastSeen timestamp
 *   - Hash        `presence:detail`   → field=profileId, value=JSON { status, customStatus }
 *   - Key         `presence:ttl:{id}` → auto-expires, triggers cleanup on miss
 *
 * Online = has a non-expired TTL key AND status !== 'invisible'
 */
class PresenceServiceSingleton {

  async heartbeat(profileId: string, status: PresenceStatus = 'online', customStatus?: string): Promise<void> {
    if (!redis.ready) return;
    const now = Date.now();

    try {
      await Promise.all([
        redis.zadd(PRESENCE_KEY, now, profileId),
        redis.hset(PRESENCE_DETAIL_KEY, profileId, JSON.stringify({ status, customStatus })),
        redis.set(`presence:ttl:${profileId}`, '1', HEARTBEAT_TTL),
      ]);
    } catch (err) {
      logger.warn('Presence heartbeat failed:', err);
    }
  }

  async setOffline(profileId: string): Promise<void> {
    if (!redis.ready) return;
    try {
      await Promise.all([
        redis.zrem(PRESENCE_KEY, profileId),
        redis.hdel(PRESENCE_DETAIL_KEY, profileId),
        redis.del(`presence:ttl:${profileId}`),
      ]);
    } catch (err) {
      logger.warn('Presence setOffline failed:', err);
    }
  }

  async getStatus(profileId: string): Promise<PresenceData | null> {
    if (!redis.ready) return null;

    try {
      const alive = await redis.exists(`presence:ttl:${profileId}`);
      if (!alive) {
        await this.cleanupStale(profileId);
        return null;
      }

      const raw = await redis.hget(PRESENCE_DETAIL_KEY, profileId);
      const lastSeenStr = await redis.zscore(PRESENCE_KEY, profileId);

      if (!raw || !lastSeenStr) return null;

      const detail = JSON.parse(raw);
      return {
        status: detail.status as PresenceStatus,
        customStatus: detail.customStatus,
        lastSeen: parseFloat(lastSeenStr),
      };
    } catch (err) {
      logger.warn('Presence getStatus failed:', err);
      return null;
    }
  }

  /**
   * Batch-fetch presence for a list of profile IDs.
   * Returns a map of profileId → PresenceData (only for online users).
   */
  async getBulkStatus(profileIds: string[]): Promise<Map<string, PresenceData>> {
    const result = new Map<string, PresenceData>();
    if (!redis.ready || profileIds.length === 0) return result;

    const client = redis.getClient();
    if (!client) return result;

    try {
      // Pipeline TTL checks + detail lookups
      const pipeline = client.pipeline();
      for (const id of profileIds) {
        pipeline.exists(`presence:ttl:${id}`);
        pipeline.hget(PRESENCE_DETAIL_KEY, id);
        pipeline.zscore(PRESENCE_KEY, id);
      }
      const responses = await pipeline.exec();
      if (!responses) return result;

      for (let i = 0; i < profileIds.length; i++) {
        const offset = i * 3;
        const alive = responses[offset]?.[1] as number;
        const rawDetail = responses[offset + 1]?.[1] as string | null;
        const lastSeen = responses[offset + 2]?.[1] as string | null;

        if (alive === 1 && rawDetail && lastSeen) {
          const detail = JSON.parse(rawDetail);
          result.set(profileIds[i], {
            status: detail.status,
            customStatus: detail.customStatus,
            lastSeen: parseFloat(lastSeen),
          });
        }
      }
    } catch (err) {
      logger.warn('Presence getBulkStatus failed:', err);
    }

    return result;
  }

  /**
   * Get all online profile IDs (heartbeat within HEARTBEAT_TTL).
   * Excludes users whose status is 'invisible'.
   */
  async getOnlineIds(): Promise<string[]> {
    if (!redis.ready) return [];
    const cutoff = Date.now() - HEARTBEAT_TTL * 1000;
    const candidates = await redis.zrangebyscore(PRESENCE_KEY, cutoff, '+inf');
    if (candidates.length === 0) return [];

    const client = redis.getClient();
    if (!client) return candidates;

    try {
      const pipeline = client.pipeline();
      for (const id of candidates) {
        pipeline.hget(PRESENCE_DETAIL_KEY, id);
      }
      const results = await pipeline.exec();
      if (!results) return candidates;

      const visible: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const raw = results[i]?.[1] as string | null;
        if (!raw) {
          visible.push(candidates[i]);
          continue;
        }
        try {
          const detail = JSON.parse(raw);
          if (detail.status !== 'invisible') {
            visible.push(candidates[i]);
          }
        } catch {
          visible.push(candidates[i]);
        }
      }
      return visible;
    } catch (err) {
      logger.warn('Presence getOnlineIds filter failed:', err);
      return candidates;
    }
  }

  private async cleanupStale(profileId: string): Promise<void> {
    try {
      await Promise.all([
        redis.zrem(PRESENCE_KEY, profileId),
        redis.hdel(PRESENCE_DETAIL_KEY, profileId),
      ]);
    } catch {
      // best-effort
    }
  }
}

export const presenceService = new PresenceServiceSingleton();
export default presenceService;
