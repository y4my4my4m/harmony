import { describe, it, expect, beforeEach, vi } from 'vitest'
import { requestDeduplicator, CacheKeys } from '@/utils/requestDeduplicator'

describe('requestDeduplicator', () => {
  beforeEach(() => {
    requestDeduplicator.clearCache()
  })

  describe('dedupe', () => {
    it('executes the fetcher and returns result', async () => {
      const fetcher = vi.fn().mockResolvedValue({ data: 'hello' })
      const result = await requestDeduplicator.dedupe('test-1', fetcher)
      expect(result).toEqual({ data: 'hello' })
      expect(fetcher).toHaveBeenCalledOnce()
    })

    it('deduplicates concurrent requests with same key', async () => {
      let resolvePromise: (value: string) => void
      const promise = new Promise<string>(resolve => { resolvePromise = resolve })
      const fetcher = vi.fn().mockReturnValue(promise)

      const p1 = requestDeduplicator.dedupe('dup-key', fetcher)
      const p2 = requestDeduplicator.dedupe('dup-key', fetcher)

      resolvePromise!('result')

      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1).toBe('result')
      expect(r2).toBe('result')
      expect(fetcher).toHaveBeenCalledOnce()
    })

    it('does not deduplicate different keys', async () => {
      const fetcher1 = vi.fn().mockResolvedValue('a')
      const fetcher2 = vi.fn().mockResolvedValue('b')

      const [r1, r2] = await Promise.all([
        requestDeduplicator.dedupe('key-a', fetcher1),
        requestDeduplicator.dedupe('key-b', fetcher2),
      ])

      expect(r1).toBe('a')
      expect(r2).toBe('b')
      expect(fetcher1).toHaveBeenCalledOnce()
      expect(fetcher2).toHaveBeenCalledOnce()
    })

    it('uses cache when cacheTTL is set', async () => {
      const fetcher = vi.fn().mockResolvedValue('cached')

      await requestDeduplicator.dedupe('cache-key', fetcher, { cacheTTL: 5000 })
      const result = await requestDeduplicator.dedupe('cache-key', fetcher, { cacheTTL: 5000 })

      expect(result).toBe('cached')
      expect(fetcher).toHaveBeenCalledOnce()
    })

    it('bypasses cache when forceRefresh is true', async () => {
      const fetcher = vi.fn()
        .mockResolvedValueOnce('first')
        .mockResolvedValueOnce('second')

      await requestDeduplicator.dedupe('force-key', fetcher, { cacheTTL: 5000 })
      const result = await requestDeduplicator.dedupe('force-key', fetcher, {
        cacheTTL: 5000,
        forceRefresh: true,
      })

      expect(result).toBe('second')
      expect(fetcher).toHaveBeenCalledTimes(2)
    })
  })

  describe('clearCache', () => {
    it('clears all cache when called without args', async () => {
      const fetcher = vi.fn().mockResolvedValue('data')
      await requestDeduplicator.dedupe('a', fetcher, { cacheTTL: 5000 })
      await requestDeduplicator.dedupe('b', fetcher, { cacheTTL: 5000 })

      requestDeduplicator.clearCache()

      expect(requestDeduplicator.getStats().cachedItems).toBe(0)
    })

    it('clears specific key', async () => {
      const fetcher = vi.fn().mockResolvedValue('data')
      await requestDeduplicator.dedupe('keep', fetcher, { cacheTTL: 5000 })
      await requestDeduplicator.dedupe('remove', fetcher, { cacheTTL: 5000 })

      requestDeduplicator.clearCache('remove')

      expect(requestDeduplicator.getStats().cachedItems).toBe(1)
    })

    it('clears by regex pattern', async () => {
      const fetcher = vi.fn().mockResolvedValue('data')
      await requestDeduplicator.dedupe('profile:1', fetcher, { cacheTTL: 5000 })
      await requestDeduplicator.dedupe('profile:2', fetcher, { cacheTTL: 5000 })
      await requestDeduplicator.dedupe('server:1', fetcher, { cacheTTL: 5000 })

      requestDeduplicator.clearCache(/^profile:/)

      expect(requestDeduplicator.getStats().cachedItems).toBe(1)
    })
  })

  describe('getStats', () => {
    it('reports zero when empty', () => {
      expect(requestDeduplicator.getStats()).toEqual({
        pendingRequests: 0,
        cachedItems: 0,
      })
    })

    it('reports cached items count', async () => {
      const fetcher = vi.fn().mockResolvedValue('data')
      await requestDeduplicator.dedupe('s1', fetcher, { cacheTTL: 5000 })
      await requestDeduplicator.dedupe('s2', fetcher, { cacheTTL: 5000 })

      expect(requestDeduplicator.getStats().cachedItems).toBe(2)
    })
  })

  describe('CacheKeys', () => {
    it('generates profile cache key', () => {
      expect(CacheKeys.profileById('123')).toBe('profile:123')
    })

    it('generates server channels cache key', () => {
      expect(CacheKeys.serverChannels('srv-1')).toBe('server-channels:srv-1')
    })

    it('generates auth user cache key', () => {
      expect(CacheKeys.authUser()).toBe('auth:user')
    })
  })
})
