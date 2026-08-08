import { describe, it, expect } from 'vitest'
import {
  trimCachedMessages,
  insertMessageSorted,
  MAX_CACHED_MESSAGES,
} from '@/stores/shared/messageCacheUtils'
import type { Message } from '@/types'

const mk = (i: number): Message =>
  ({
    id: `m${i}`,
    content: `msg ${i}`,
    created_at: new Date(1700000000000 + i * 1000).toISOString(),
  }) as any

const cacheOf = (id: string, count: number) =>
  new Map([[id, { messages: Array.from({ length: count }, (_, i) => mk(i)) }]])

describe('trimCachedMessages', () => {
  it('bounds a conversation that grew past the cap', () => {
    const cache = cacheOf('c1', 5000)

    trimCachedMessages(cache, 'c1')

    expect(cache.get('c1')!.messages.length).toBe(MAX_CACHED_MESSAGES)
  })

  it('keeps the newest messages and drops the oldest', () => {
    const cache = cacheOf('c1', 1000)

    trimCachedMessages(cache, 'c1')

    const kept = cache.get('c1')!.messages
    // Arrays are created_at-ascending.
    expect(kept[kept.length - 1].id).toBe('m999')
    expect(kept[0].id).toBe(`m${1000 - MAX_CACHED_MESSAGES}`)
  })

  it('leaves the retained slice in ascending created_at order', () => {
    const cache = cacheOf('c1', 1000)

    trimCachedMessages(cache, 'c1')

    const times = cache.get('c1')!.messages.map(m => new Date(m.created_at).getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('is a no-op below the cap', () => {
    const cache = cacheOf('c1', 10)

    trimCachedMessages(cache, 'c1')

    expect(cache.get('c1')!.messages.length).toBe(10)
  })

  it('ignores an unknown conversation id', () => {
    const cache = cacheOf('c1', 10)

    expect(() => trimCachedMessages(cache, 'nope')).not.toThrow()
    expect(() => trimCachedMessages(cache, '')).not.toThrow()
    expect(cache.get('c1')!.messages.length).toBe(10)
  })

  it('does not touch other conversations', () => {
    const cache = cacheOf('c1', 5000)
    cache.set('c2', { messages: Array.from({ length: 4000 }, (_, i) => mk(i)) })

    trimCachedMessages(cache, 'c1')

    expect(cache.get('c2')!.messages.length).toBe(4000)
  })

  it('still accepts sorted inserts after a trim', () => {
    const cache = cacheOf('c1', 1000)
    trimCachedMessages(cache, 'c1')

    const arr = cache.get('c1')!.messages
    insertMessageSorted(arr, mk(2000))

    expect(arr.length).toBe(MAX_CACHED_MESSAGES + 1)
    expect(arr[arr.length - 1].id).toBe('m2000')
  })
})
