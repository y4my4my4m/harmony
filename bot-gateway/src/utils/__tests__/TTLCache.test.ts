import { describe, it, expect, vi, afterEach } from 'vitest'
import { TTLCache } from '../TTLCache.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TTLCache.entries', () => {
  it('lists live entries, least recently used first, and skips expired ones', () => {
    let clock = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const cache = new TTLCache<string, number>(10, 100)
    cache.set('a', 1)
    clock += 60
    cache.set('b', 2)
    cache.set('c', 3)
    cache.get('b')
    clock += 50

    expect(cache.entries()).toEqual([['c', 3], ['b', 2]])
  })

  it('leaves recency alone', () => {
    const cache = new TTLCache<string, number>(2, 60_000)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.entries()
    cache.set('c', 3)

    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
  })
})
