import { redis } from './RedisService.js';
import { logger } from '../utils/logger.js';

const TYPING_TTL = 5; // seconds - auto-expires
const TYPING_KEY_PREFIX = 'typing:';

export interface TypingUser {
  profileId: string;
  username: string;
  startedAt: number;
}

/**
 * Redis-backed typing indicator service.
 *
 * Each typing event is stored as a hash field with a TTL-based key:
 *   typing:{contextType}:{contextId} → hash { profileId: JSON { username, startedAt } }
 *
 * The hash key gets an auto-expiring companion:
 *   typing:ttl:{contextType}:{contextId}:{profileId} → '1' with 5s TTL
 *
 * Clients poll or subscribe to pub/sub channel `typing:{contextType}:{contextId}`.
 */
class TypingServiceSingleton {

  async startTyping(
    contextType: 'channel' | 'conversation' | 'thread',
    contextId: string,
    profileId: string,
    username: string
  ): Promise<void> {
    if (!redis.ready) return;

    const hashKey = `${TYPING_KEY_PREFIX}${contextType}:${contextId}`;
    const ttlKey = `typing:ttl:${contextType}:${contextId}:${profileId}`;
    const now = Date.now();

    try {
      await Promise.all([
        redis.hset(hashKey, profileId, JSON.stringify({ username, startedAt: now })),
        redis.set(ttlKey, '1', TYPING_TTL),
      ]);

      await redis.publish(`typing:${contextType}:${contextId}`, JSON.stringify({
        event: 'start',
        profileId,
        username,
      }));
    } catch (err) {
      logger.warn('Typing startTyping failed:', err);
    }
  }

  async stopTyping(
    contextType: 'channel' | 'conversation' | 'thread',
    contextId: string,
    profileId: string
  ): Promise<void> {
    if (!redis.ready) return;

    const hashKey = `${TYPING_KEY_PREFIX}${contextType}:${contextId}`;
    const ttlKey = `typing:ttl:${contextType}:${contextId}:${profileId}`;

    try {
      await Promise.all([
        redis.hdel(hashKey, profileId),
        redis.del(ttlKey),
      ]);

      await redis.publish(`typing:${contextType}:${contextId}`, JSON.stringify({
        event: 'stop',
        profileId,
      }));
    } catch (err) {
      logger.warn('Typing stopTyping failed:', err);
    }
  }

  /**
   * Get currently typing users in a context.
   * Filters out stale entries whose TTL key has expired.
   */
  async getTypingUsers(
    contextType: 'channel' | 'conversation' | 'thread',
    contextId: string
  ): Promise<TypingUser[]> {
    if (!redis.ready) return [];

    const hashKey = `${TYPING_KEY_PREFIX}${contextType}:${contextId}`;

    try {
      const all = await redis.hgetall(hashKey);
      if (!all) return [];

      const client = redis.getClient();
      if (!client) return [];

      const profileIds = Object.keys(all);
      const pipeline = client.pipeline();
      for (const pid of profileIds) {
        pipeline.exists(`typing:ttl:${contextType}:${contextId}:${pid}`);
      }
      const results = await pipeline.exec();
      if (!results) return [];

      const active: TypingUser[] = [];
      const stale: string[] = [];

      for (let i = 0; i < profileIds.length; i++) {
        const alive = results[i]?.[1] as number;
        if (alive === 1) {
          const data = JSON.parse(all[profileIds[i]]);
          active.push({
            profileId: profileIds[i],
            username: data.username,
            startedAt: data.startedAt,
          });
        } else {
          stale.push(profileIds[i]);
        }
      }

      if (stale.length > 0) {
        redis.hdel(hashKey, ...stale).catch(() => {});
      }

      return active;
    } catch (err) {
      logger.warn('Typing getTypingUsers failed:', err);
      return [];
    }
  }
}

export const typingService = new TypingServiceSingleton();
export default typingService;
