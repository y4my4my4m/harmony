import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { supabase } from '@/supabase'
import { createFakePostgrest } from '../../../tests/helpers/fakePostgrest'

vi.mock('@/services/userDataService', () => ({
  userDataService: {
    getCurrentUser: () => ({ id: 'me' }),
  },
}))

vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: async () => ({
      isAuthenticated: true,
      authUser: { id: 'me' },
      profileId: 'me',
    }),
    getCurrentProfileId: async () => 'me',
  },
}))

import { useActivityPubStore } from '@/stores/useActivityPub'
import { services } from '@/services'

function seedDb(tables: Record<string, any[]>) {
  const db = createFakePostgrest(tables)
  ;(supabase.from as any).mockImplementation(db.from)
  return db
}

describe('useActivityPub follow counters', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  // Bug #9: the optimistic increment and the broadcast both counted the same
  // follow.
  it('counts one follow once', async () => {
    seedDb({ follows: [] })
    vi.spyOn(services.interactions, 'toggleFollow').mockResolvedValue({ following: true, pending: false } as any)

    const store = useActivityPubStore()
    await store.followUser('them')
    await store.handleRealtimeFollowCreate({
      op: 'INSERT', follower_id: 'me', following_id: 'them', status: 'accepted',
    })

    expect(store.followingCount).toBe(1)
    expect(store.followedUsers.has('them')).toBe(true)
  })

  it('drops the follow once on unfollow', async () => {
    seedDb({ follows: [] })
    vi.spyOn(services.interactions, 'toggleFollow').mockResolvedValue({ following: false, pending: false } as any)

    const store = useActivityPubStore()
    store.followedUsers = new Set(['them'])
    store.followingCount = 1

    await store.unfollowUser('them')
    await store.handleRealtimeFollowDelete({
      op: 'DELETE', follower_id: 'me', following_id: 'them', status: 'accepted',
    })

    expect(store.followingCount).toBe(0)
  })

  // Bug #10: the database counts accepted follows only.
  it('ignores a pending follow request', async () => {
    seedDb({ follows: [] })
    const store = useActivityPubStore()

    await store.handleRealtimeFollowCreate({
      op: 'INSERT', follower_id: 'them', following_id: 'me', status: 'pending',
    })

    expect(store.followersCount).toBe(0)
  })

  it('does not mark a pending outgoing request as followed', async () => {
    seedDb({ follows: [] })
    const store = useActivityPubStore()

    await store.handleRealtimeFollowCreate({
      op: 'INSERT', follower_id: 'me', following_id: 'them', status: 'pending',
    })

    expect(store.followedUsers.has('them')).toBe(false)
    expect(store.followingCount).toBe(0)
  })

  // Bug #10: pending -> accepted is where the follower count moves.
  it('counts the follower when the request is accepted', async () => {
    seedDb({ follows: [{ id: 'f1', follower_id: 'them', following_id: 'me', status: 'accepted' }] })
    const store = useActivityPubStore()

    await store.handleRealtimeFollowCreate({
      op: 'INSERT', follower_id: 'them', following_id: 'me', status: 'pending',
    })
    await store.handleRealtimeFollowUpdate({
      op: 'UPDATE', follower_id: 'them', following_id: 'me', status: 'accepted',
    })

    expect(store.followersCount).toBe(1)
  })

  it('counts the outgoing follow once the request is accepted', async () => {
    seedDb({ follows: [] })
    const store = useActivityPubStore()

    await store.handleRealtimeFollowCreate({
      op: 'INSERT', follower_id: 'me', following_id: 'them', status: 'pending',
    })
    await store.handleRealtimeFollowUpdate({
      op: 'UPDATE', follower_id: 'me', following_id: 'them', status: 'accepted',
    })

    expect(store.followedUsers.has('them')).toBe(true)
    expect(store.followingCount).toBe(1)
  })

  // `follows` rows are also updated for federation bookkeeping, which
  // rebroadcasts status='accepted' with no count change behind it.
  it('does not recount an accepted follow on a repeat update', async () => {
    seedDb({ follows: [{ id: 'f1', follower_id: 'them', following_id: 'me', status: 'accepted' }] })
    const store = useActivityPubStore()

    await store.handleRealtimeFollowUpdate({
      op: 'UPDATE', follower_id: 'them', following_id: 'me', status: 'accepted',
    })
    await store.handleRealtimeFollowUpdate({
      op: 'UPDATE', follower_id: 'them', following_id: 'me', status: 'accepted',
    })

    expect(store.followersCount).toBe(1)
  })

  it('does not discount a withdrawn pending request', async () => {
    seedDb({ follows: [] })
    const store = useActivityPubStore()

    await store.handleRealtimeFollowDelete({
      op: 'DELETE', follower_id: 'them', following_id: 'me', status: 'pending',
    })

    expect(store.followersCount).toBe(0)
  })
})

describe('useActivityPub toggleReblog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  // Bug #3: the store held its own copy of the un-boost lookup, whose only
  // match after a quote is the quote post.
  it('retracts the boost and leaves the quote', async () => {
    const db = seedDb({
      posts: [
        { id: 'orig-1', is_deleted: false },
        { id: 'quote-1', author_id: 'me', is_deleted: false, metadata: { reblog_of: 'orig-1', is_quote: true } },
        { id: 'boost-1', author_id: 'me', is_deleted: false, metadata: { reblog_of: 'orig-1' } },
      ],
      post_interactions: [
        { id: 'int-1', user_id: 'me', post_id: 'orig-1', interaction_type: 'reblog' },
      ],
    })

    const store = useActivityPubStore()
    await store.toggleReblog('orig-1')

    expect(db.tables.posts.find((p: any) => p.id === 'quote-1').is_deleted).toBe(false)
    expect(db.tables.posts.find((p: any) => p.id === 'boost-1').is_deleted).toBe(true)
    expect(db.tables.post_interactions).toHaveLength(0)
  })
})

describe('useActivityPub realtime count fan-out', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  // Bug #13: interactions resolve to the original post id, so a boost wrapper
  // is only reachable through its embedded reblog.
  it('updates a boost wrapper from the original post id', async () => {
    seedDb({
      posts: [{ id: 'orig-1', favorites_count: 6, reblogs_count: 2, replies_count: 1 }],
    })
    const store = useActivityPubStore()
    store.homeFeed.posts = [{
      id: 'wrapper-1',
      favorites_count: 0,
      reblogs_count: 0,
      replies_count: 0,
      reblog: { id: 'orig-1', favorites_count: 5, reblogs_count: 2, replies_count: 1 },
    } as any]

    await store.updatePostInteractionFromRealtime('orig-1', 'favorite', 'INSERT', 'someone')

    expect((store.homeFeed.posts[0] as any).reblog.favorites_count).toBe(6)
  })

  it('sets the current user state on the embedded original', async () => {
    seedDb({
      posts: [{ id: 'orig-1', favorites_count: 6, reblogs_count: 2, replies_count: 1 }],
    })
    const store = useActivityPubStore()
    store.homeFeed.posts = [{
      id: 'wrapper-1',
      reblog: { id: 'orig-1', favorites_count: 5, reblogs_count: 2, replies_count: 1, is_favorited: false },
    } as any]

    await store.updatePostInteractionFromRealtime('orig-1', 'favorite', 'INSERT', 'me')

    expect((store.homeFeed.posts[0] as any).reblog.is_favorited).toBe(true)
  })

  // The wrapper's own counts are not the original's.
  it('does not copy wrapper counts over the embedded original', async () => {
    seedDb({
      posts: [{ id: 'wrapper-1', favorites_count: 1, reblogs_count: 0, replies_count: 0 }],
    })
    const store = useActivityPubStore()
    store.homeFeed.posts = [{
      id: 'wrapper-1',
      favorites_count: 0,
      reblogs_count: 0,
      replies_count: 0,
      reblog: { id: 'orig-1', favorites_count: 5, reblogs_count: 2, replies_count: 1 },
    } as any]

    await store.updatePostInteractionFromRealtime('wrapper-1', 'favorite', 'INSERT', 'someone')

    expect((store.homeFeed.posts[0] as any).reblog.favorites_count).toBe(5)
    expect((store.homeFeed.posts[0] as any).favorites_count).toBe(1)
  })

  it('updates a boost wrapper held in a user feed', async () => {
    seedDb({
      posts: [{ id: 'orig-1', favorites_count: 9, reblogs_count: 3, replies_count: 2 }],
    })
    const store = useActivityPubStore()
    store.userFeeds.set('them', {
      posts: [{ id: 'wrapper-2', reblog: { id: 'orig-1', favorites_count: 8, reblogs_count: 3, replies_count: 2 } }],
    } as any)

    await store.updatePostInteractionCounts('orig-1', 'favorite', 'INSERT')

    expect((store.userFeeds.get('them') as any).posts[0].reblog.favorites_count).toBe(9)
  })
})
