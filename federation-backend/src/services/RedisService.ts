import Redis from 'ioredis';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';

const KEY_PREFIX = 'harmony:';

class RedisServiceSingleton {
  private client: Redis | null = null;
  private subscriber: Redis | null = null;
  private _ready = false;

  get ready(): boolean {
    return this._ready;
  }

  async connect(): Promise<void> {
    if (this.client) return;

    try {
      this.client = new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          if (times > 10) return null; // stop retrying
          return Math.min(times * 200, 5000);
        },
        lazyConnect: false,
        keyPrefix: KEY_PREFIX,
      });

      this.client.on('connect', () => {
        logger.info('Redis connected');
        this._ready = true;
      });

      this.client.on('error', (err) => {
        logger.error('Redis error:', err.message);
        this._ready = false;
      });

      this.client.on('close', () => {
        logger.warn('Redis connection closed');
        this._ready = false;
      });

      this.client.on('reconnecting', () => {
        logger.info('Redis reconnecting...');
      });

      await this.client.ping();
      this._ready = true;
      logger.info('Redis ready');
    } catch (err) {
      logger.warn('Redis connection failed, running without cache:', (err as Error).message);
      this.client = null;
      this._ready = false;
    }
  }

  /**
   * Dedicated subscriber connection for pub/sub.
   * ioredis requires a separate connection for subscriptions.
   */
  getSubscriber(): Redis | null {
    if (!this.client) return null;
    if (!this.subscriber) {
      this.subscriber = this.client.duplicate();
      this.subscriber.on('error', (err) => {
        logger.error('Redis subscriber error:', err.message);
      });
    }
    return this.subscriber;
  }

  getClient(): Redis | null {
    return this.client;
  }

  // -- Key/Value ---------------------------------------------------------

  async get(key: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    if (!this.client) return false;
    try {
      if (ttlSeconds) {
        await this.client.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, value);
      }
      return true;
    } catch {
      return false;
    }
  }

  async del(...keys: string[]): Promise<number> {
    if (!this.client) return 0;
    try {
      return await this.client.del(...keys);
    } catch {
      return 0;
    }
  }

  async exists(key: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      return (await this.client.exists(key)) === 1;
    } catch {
      return false;
    }
  }

  async ttl(key: string): Promise<number> {
    if (!this.client) return -2;
    try {
      return await this.client.ttl(key);
    } catch {
      return -2;
    }
  }

  // -- JSON helpers -------------------------------------------------------

  async getJSON<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJSON<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    return this.set(key, JSON.stringify(value), ttlSeconds);
  }

  // -- Hash operations ----------------------------------------------------

  async hget(key: string, field: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      return await this.client.hget(key, field);
    } catch {
      return null;
    }
  }

  async hset(key: string, field: string, value: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.hset(key, field, value);
      return true;
    } catch {
      return false;
    }
  }

  async hmset(key: string, data: Record<string, string>): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.hmset(key, data);
      return true;
    } catch {
      return false;
    }
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    if (!this.client) return null;
    try {
      const result = await this.client.hgetall(key);
      return Object.keys(result).length > 0 ? result : null;
    } catch {
      return null;
    }
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    if (!this.client) return 0;
    try {
      return await this.client.hdel(key, ...fields);
    } catch {
      return 0;
    }
  }

  // -- Sorted sets (for presence, leaderboards, etc.) ----------------------

  async zadd(key: string, score: number, member: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.zadd(key, score, member);
      return true;
    } catch {
      return false;
    }
  }

  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    if (!this.client) return [];
    try {
      return await this.client.zrangebyscore(key, min, max);
    } catch {
      return [];
    }
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    if (!this.client) return 0;
    try {
      return await this.client.zrem(key, ...members);
    } catch {
      return 0;
    }
  }

  async zscore(key: string, member: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      return await this.client.zscore(key, member);
    } catch {
      return null;
    }
  }

  // -- Atomic rate limiting -----------------------------------------------

  /**
   * Sliding-window rate limit using INCR + EXPIRE.
   * Returns { allowed: boolean, remaining: number, resetMs: number }
   */
  async rateLimit(
    key: string,
    maxRequests: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; remaining: number; resetMs: number }> {
    if (!this.client) {
      return { allowed: true, remaining: maxRequests, resetMs: 0 };
    }
    try {
      const pipeline = this.client.multi();
      pipeline.incr(key);
      pipeline.ttl(key);
      const results = await pipeline.exec();
      if (!results) return { allowed: true, remaining: maxRequests, resetMs: 0 };

      const count = (results[0][1] as number) || 0;
      const currentTtl = (results[1][1] as number) || -1;

      if (currentTtl === -1) {
        await this.client.expire(key, windowSeconds);
      }

      const remaining = Math.max(0, maxRequests - count);
      const resetMs = currentTtl > 0 ? currentTtl * 1000 : windowSeconds * 1000;

      return { allowed: count <= maxRequests, remaining, resetMs };
    } catch {
      return { allowed: true, remaining: maxRequests, resetMs: 0 };
    }
  }

  // -- Pub/Sub ------------------------------------------------------------

  async publish(channel: string, message: string): Promise<number> {
    if (!this.client) return 0;
    try {
      return await this.client.publish(KEY_PREFIX + channel, message);
    } catch {
      return 0;
    }
  }

  // -- Lifecycle ----------------------------------------------------------

  async disconnect(): Promise<void> {
    if (this.subscriber) {
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this._ready = false;
    logger.info('Redis disconnected');
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs?: number }> {
    if (!this.client) return { ok: false };
    try {
      const start = Date.now();
      await this.client.ping();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false };
    }
  }
}

export const redis = new RedisServiceSingleton();
export default redis;
