/**
 * A small bounded cache with per-entry TTL.
 *
 * Use for read-mostly lookups whose source data changes infrequently
 * (e.g. channel → server mappings, server → bot permissions). Eviction
 * policy: on overflow, the least-recently-used entry is dropped (Map
 * insertion order is updated on read/write to track recency). Expired
 * entries are dropped lazily on read.
 *
 * NOT a substitute for invalidation. If you mutate the underlying data
 * directly, call `delete(key)` or `clear()`. Otherwise the TTL gives a
 * worst-case staleness bound.
 */
export class TTLCache<K, V> {
  private readonly store = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
  ) {
    if (maxSize <= 0) throw new Error(`TTLCache: maxSize must be > 0`);
    if (ttlMs <= 0) throw new Error(`TTLCache: ttlMs must be > 0`);
  }

  get size(): number {
    return this.store.size;
  }

  get(key: K): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // LRU touch.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  set(key: K, value: V): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}
