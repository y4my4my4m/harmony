import NodeCache from 'node-cache';

/**
 * In-memory cache for user profiles, server data, etc.
 * TTL: 5 minutes by default
 */
class CacheService {
  private cache: NodeCache;

  constructor() {
    this.cache = new NodeCache({
      stdTTL: 300, // 5 minutes
      checkperiod: 60, // Check for expired keys every 60 seconds
      useClones: false, // Better performance, but be careful with mutations
    });
  }

  get<T>(key: string): T | undefined {
    return this.cache.get<T>(key);
  }

  set<T>(key: string, value: T, ttl?: number): boolean {
    return this.cache.set(key, value, ttl || 300);
  }

  del(key: string): number {
    return this.cache.del(key);
  }

  flush(): void {
    this.cache.flushAll();
  }

  keys(): string[] {
    return this.cache.keys();
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  // Helper methods for common cache patterns
  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    const value = await factory();
    this.set(key, value, ttl);
    return value;
  }
}

export const cache = new CacheService();
export default cache;

