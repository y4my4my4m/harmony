import { describe, it, expect } from 'vitest'
import { insertRealtimePost, flushPendingPosts, placeByDate, addedAtHead } from '@/utils/realtimeFeed'

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

describe('placeByDate', () => {
  const d = (id: string, minute: number) => ({ id, created_at: `2026-10-21T10:${String(minute).padStart(2, '0')}:00.000000+00:00` })

  it('puts a new post first', () => {
    expect(ids(placeByDate([d('b', 20), d('a', 10)], d('c', 30), false))).toEqual(['c', 'b', 'a'])
  })

  it('fills an outbox backfill in date order: the top stays put as older posts arrive', () => {
    let posts: Array<ReturnType<typeof d>> = []
    for (const post of [d('e', 50), d('d', 40), d('c', 30), d('b', 20), d('a', 10)]) {
      posts = placeByDate(posts, post, false)
      expect(posts[0].id).toBe('e')
    }
    expect(ids(posts)).toEqual(['e', 'd', 'c', 'b', 'a'])
  })

  it('places a post between two by date, and breaks a tie by id as the feed query does', () => {
    expect(ids(placeByDate([d('c', 30), d('a', 10)], d('b', 20), true))).toEqual(['c', 'b', 'a'])
    expect(ids(placeByDate([d('b', 20), d('a', 20)], d('ab', 20), true))).toEqual(['b', 'ab', 'a'])
  })

  it('leaves a post older than a full page to the next page', () => {
    const posts = [d('c', 30), d('b', 20)]
    expect(placeByDate(posts, d('a', 10), true)).toBe(posts)
    expect(ids(placeByDate(posts, d('a', 10), false))).toEqual(['c', 'b', 'a'])
  })

  it('returns the same list for a post already listed', () => {
    const posts = [d('b', 20), d('a', 10)]
    expect(placeByDate(posts, d('a', 10), false)).toBe(posts)
  })
})

describe('addedAtHead', () => {
  const list = (...xs: string[]) => xs.map(p)

  it('counts posts placed ahead of the listed ones', () => {
    expect(addedAtHead(list('b', 'a'), list('c', 'b', 'a'))).toBe(1)
    expect(addedAtHead(list('b', 'a'), list('e', 'd', 'b', 'a'))).toBe(2)
  })

  it('counts them when the cap cut the tail', () => {
    expect(addedAtHead(list('c', 'b', 'a'), list('d', 'c', 'b'))).toBe(1)
  })

  it('is 0 for an append, a removal, a reorder or another list', () => {
    expect(addedAtHead(list('b', 'a'), list('b', 'a', 'z'))).toBe(0)
    expect(addedAtHead(list('c', 'b', 'a'), list('c', 'a'))).toBe(0)
    expect(addedAtHead(list('b', 'a'), list('c', 'a', 'b'))).toBe(0)
    expect(addedAtHead(list('b', 'a'), list('y', 'x'))).toBe(0)
    expect(addedAtHead([], list('a'))).toBe(0)
  })
})
