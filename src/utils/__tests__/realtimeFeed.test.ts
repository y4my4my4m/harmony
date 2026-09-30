import { describe, it, expect } from 'vitest'
import { insertRealtimePost, flushPendingPosts } from '@/utils/realtimeFeed'

const p = (id: string) => ({ id })
const ids = (list: Array<{ id: string }>) => list.map(x => x.id)

describe('insertRealtimePost', () => {
  it('prepends to a live feed', () => {
    const r = insertRealtimePost([p('b'), p('a')], [], p('c'), true)
    expect(ids(r.posts)).toEqual(['c', 'b', 'a'])
    expect(r.pending).toEqual([])
    expect(r.trimmed).toBe(false)
  })

  it('caps a live feed and reports the trim', () => {
    const r = insertRealtimePost([p('b'), p('a')], [], p('c'), true, 2)
    expect(ids(r.posts)).toEqual(['c', 'b'])
    expect(r.trimmed).toBe(true)
  })

  it('queues without touching the loaded list when the viewer has scrolled', () => {
    const loaded = Array.from({ length: 150 }, (_, i) => p(`old${i}`))
    const r = insertRealtimePost(loaded, [p('n1')], p('n2'), false)
    expect(r.posts).toBe(loaded)
    expect(r.posts).toHaveLength(150)
    expect(ids(r.pending)).toEqual(['n2', 'n1'])
    expect(r.trimmed).toBe(false)
  })

  it('ignores a post already loaded or queued', () => {
    const posts = [p('a')]
    const pending = [p('b')]
    expect(insertRealtimePost(posts, pending, p('a'), true).posts).toBe(posts)
    const r = insertRealtimePost(posts, pending, p('b'), false)
    expect(r.pending).toBe(pending)
  })
})

describe('flushPendingPosts', () => {
  it('puts queued posts ahead of the loaded list in queue order', () => {
    expect(ids(flushPendingPosts([p('a')], [p('c'), p('b')]))).toEqual(['c', 'b', 'a'])
  })

  it('drops queued posts that are already loaded or repeated', () => {
    expect(ids(flushPendingPosts([p('a')], [p('b'), p('a'), p('b')]))).toEqual(['b', 'a'])
  })

  it('returns the same list when nothing is queued', () => {
    const posts = [p('a')]
    expect(flushPendingPosts(posts, [])).toBe(posts)
  })
})
