import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { supabase } from '@/supabase'
import { createFakePostgrest } from '../../../tests/helpers/fakePostgrest'

vi.mock('@/services/userDataService', () => ({
  userDataService: {
    getCurrentUser: () => ({ id: 'me' }),
  },
}))

// profiles.id and auth.users.id are independent uuids; post_interactions.user_id
// is the profile id.
vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: async () => ({
      isAuthenticated: true,
      authUser: { id: 'auth-me' },
      profileId: 'me',
    }),
    getCurrentProfileId: async () => 'me',
  },
}))

import { useActivityPubStore } from '@/stores/useActivityPub'
import { services } from '@/services'
import { activityPubService } from '@/services/activityPubService'

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

  it('leaves another profile\'s interaction out of my state', async () => {
    seedDb({ posts: [{ id: 'p1', favorites_count: 3, reblogs_count: 0, replies_count: 0 }] })
    const store = useActivityPubStore()
    store.homeFeed.posts = [{ id: 'p1', is_favorited: false } as any]

    await store.updatePostInteractionFromRealtime('p1', 'favorite', 'INSERT', 'them')

    expect((store.homeFeed.posts[0] as any).is_favorited).toBe(false)
  })

  // is_favorited spans favorite and emoji_reaction, and a user holds one row
  // per emoji.
  it('keeps the heart when a removed emoji reaction leaves a favorite', async () => {
    seedDb({
      posts: [{ id: 'p1', favorites_count: 1, reblogs_count: 0, replies_count: 0 }],
      post_interactions: [{ id: 'i1', post_id: 'p1', user_id: 'me', interaction_type: 'favorite' }],
    })
    const store = useActivityPubStore()
    store.homeFeed.posts = [{ id: 'p1', is_favorited: true } as any]

    await store.updatePostInteractionFromRealtime('p1', 'emoji_reaction', 'DELETE', 'me')

    expect((store.homeFeed.posts[0] as any).is_favorited).toBe(true)
  })

  it('empties the heart once the last heart row is gone', async () => {
    seedDb({
      posts: [{ id: 'p1', favorites_count: 0, reblogs_count: 0, replies_count: 0 }],
      post_interactions: [],
    })
    const store = useActivityPubStore()
    store.homeFeed.posts = [{ id: 'p1', is_favorited: true } as any]

    await store.updatePostInteractionFromRealtime('p1', 'favorite', 'DELETE', 'me')

    expect((store.homeFeed.posts[0] as any).is_favorited).toBe(false)
  })

  it('lights the heart on an emoji reaction insert', async () => {
    seedDb({ posts: [{ id: 'p1', favorites_count: 1, reblogs_count: 0, replies_count: 0 }] })
    const store = useActivityPubStore()
    store.homeFeed.posts = [{ id: 'p1', is_favorited: false } as any]

    await store.updatePostInteractionFromRealtime('p1', 'emoji_reaction', 'INSERT', 'me')

    expect((store.homeFeed.posts[0] as any).is_favorited).toBe(true)
  })
})

describe('useActivityPub background home refresh', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  const makePosts = (n: number, offset = 0) =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i + offset}`,
      created_at: new Date(Date.UTC(2024, 0, 1, 0, 0, 0) - (i + offset) * 60_000).toISOString(),
    })) as any[]

  function stubEnrichment(store: any) {
    ;(supabase.rpc as any).mockResolvedValue({ data: [], error: null })
    vi.spyOn(store, 'batchFetchReblogInteractions').mockImplementation(async (p: any) => p)
    vi.spyOn(store, 'ensureAuthorProfilesCached').mockResolvedValue(undefined)
    vi.spyOn(store, 'batchFetchRemoteReactions').mockResolvedValue(undefined)
    vi.spyOn(store, 'saveTimelineToCache').mockImplementation(() => {})
  }

  // The cache holds 30 posts, the refresh page 20.
  it('keeps the cached posts the refresh page does not cover', async () => {
    const store = useActivityPubStore()
    stubEnrichment(store)
    const cached = makePosts(30)
    store.homeFeed.posts = cached.map((p) => ({ ...p }))

    vi.spyOn(activityPubService, 'getUserTimeline').mockResolvedValue({
      posts: cached.slice(0, 20).map((p) => ({ ...p, content: 'fresh' })),
      fullPage: true,
    } as any)

    await store.refreshHomeFeedInBackground()

    expect(store.homeFeed.posts).toHaveLength(30)
    expect((store.homeFeed.posts[0] as any).content).toBe('fresh')
    expect(store.homeFeed.posts[29].id).toBe('p29')
    expect(store.homeFeed.cursor).toBe(cached[29].created_at)
  })

  it('drops a post the refresh page no longer carries', async () => {
    const store = useActivityPubStore()
    stubEnrichment(store)
    store.homeFeed.posts = makePosts(3)

    vi.spyOn(activityPubService, 'getUserTimeline').mockResolvedValue({
      posts: [makePosts(3)[0], makePosts(3)[2]],
      fullPage: false,
    } as any)

    await store.refreshHomeFeedInBackground()

    expect(store.homeFeed.posts.map((p) => p.id)).toEqual(['p0', 'p2'])
  })

  it('skips the refresh while a home load is in flight', async () => {
    const store = useActivityPubStore()
    store.loadingFeeds.home = true
    const timeline = vi.spyOn(activityPubService, 'getUserTimeline')

    await store.refreshHomeFeedInBackground()

    expect(timeline).not.toHaveBeenCalled()
  })

  it('excludes a home load while the refresh is in flight', async () => {
    const store = useActivityPubStore()
    stubEnrichment(store)
    store.homeFeed.posts = makePosts(2)

    let release: (v: any) => void = () => {}
    const timeline = vi.spyOn(activityPubService, 'getUserTimeline').mockReturnValue(
      new Promise((resolve) => { release = resolve }) as any
    )

    const refresh = store.refreshHomeFeedInBackground()
    await store.loadHomeFeed()

    expect(timeline).toHaveBeenCalledTimes(1)

    release({ posts: makePosts(2), fullPage: false })
    await refresh
  })
})
