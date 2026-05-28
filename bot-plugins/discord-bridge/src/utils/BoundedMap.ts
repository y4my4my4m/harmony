/**
 * A Map with a fixed maximum size that evicts the oldest entry on overflow.
 *
 * Uses the insertion-order guarantee of native Map: the first entry yielded
 * by `keys().next()` is the oldest. On every `set()` we move the key to the
 * end (delete + re-insert) so the iteration order tracks recency. This makes
 * the eviction policy effectively LRU on writes; reads also touch the key
 * (configurable) so a busy key stays alive.
 *
 * This is a *bounded* cache - when full, set() discards the least recently
 * used entry. It is NOT a TTL cache; pair with an external sweep if you
 * need time-based expiration.
 *
 * Use this instead of a raw `Map` for any long-lived process state that
 * accumulates entries (message-id mappings, user caches, etc.) where the
 * cardinality is open-ended.
 */
export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(
    private readonly maxSize: number,
    private readonly touchOnRead = true,
  ) {
    if (maxSize <= 0) {
      throw new Error(`BoundedMap: maxSize must be > 0, got ${maxSize}`);
    }
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    if (this.touchOnRead) {
      // Move to the end of iteration order so it's the most-recently-used.
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) {
      // Re-insert to update recency.
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict the oldest (first inserted / least recently used) entry.
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(key, value);
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }
}
