import NodeCache from 'node-cache';
import { redis } from '../services/RedisService.js';
import { logger } from './logger.js';

/**
 * Two-tier cache: L1 in-memory (NodeCache) + L2 Redis.
 * Falls back to L1-only when Redis is unavailable.
 *
 * Write-through: set() writes to both L1 and L2.
 * Read: L1 first, then L2 (promotes to L1 on hit).
 */
class CacheService {
  private l1: NodeCache;

  constructor() {
    this.l1 = new NodeCache({
      stdTTL: 300,
      checkperiod: 60,
      useClones: false,
    });
  }

  get<T>(key: string): T | undefined {
    return this.l1.get<T>(key);
  }

  async getAsync<T>(key: string): Promise<T | undefined> {
    const l1Hit = this.l1.get<T>(key);
    if (l1Hit !== undefined) return l1Hit;

    if (!redis.ready) return undefined;

    const l2Hit = await redis.getJSON<T>(`cache:${key}`);
    if (l2Hit !== null) {
      const ttl = await redis.ttl(`cache:${key}`);
      this.l1.set(key, l2Hit, ttl > 0 ? ttl : 300);
      return l2Hit;
    }
    return undefined;
  }

  set<T>(key: string, value: T, ttl?: number): boolean {
    const effectiveTtl = ttl || 300;
    const ok = this.l1.set(key, value, effectiveTtl);

    if (redis.ready) {
      redis.setJSON(`cache:${key}`, value, effectiveTtl).catch((err) => {
        logger.warn('Redis cache set failed:', err);
      });
    }

    return ok;
  }

  del(key: string): number {
    const count = this.l1.del(key);
    if (redis.ready) {
      redis.del(`cache:${key}`).catch(() => {});
    }
    return count;
  }

  flush(): void {
    this.l1.flushAll();
  }

  keys(): string[] {
    return this.l1.keys();
  }

  has(key: string): boolean {
    return this.l1.has(key);
  }

  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    const cached = await this.getAsync<T>(key);
    if (cached !== undefined) return cached;

    const value = await factory();
    this.set(key, value, ttl);
    return value;
  }
}

export const cache = new CacheService();
export default cache;
