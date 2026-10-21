/**
 * Timelines kept across tab switches and post views: enterTimeline keeps a recently
 * fetched list and fetches only its head, leaveTimeline holds the reading position, and
 * posts above a held position queue behind the pill. Also the "New post" draft slot.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('@/services/userDataService', () => ({
  userDataService: {
    getCurrentUser: () => ({ id: 'me' }),
  },
}))

vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: async () => ({ isAuthenticated: true, authUser: { id: 'auth-me' }, profileId: 'me' }),
    getCurrentProfileId: async () => 'me',
  },
}))

import { useActivityPubStore, type FeedScrollAnchor } from '@/stores/useActivityPub'
import { activityPubService } from '@/services/activityPubService'

// p0 is the newest; a minute apart.
const post = (n: number) => ({
  id: `p${n}`,
  author_id: 'them',
  created_at: new Date(Date.UTC(2026, 0, 1) - n * 60_000).toISOString(),
}) as any
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => post(from + i))
const ids = (posts: Array<{ id: string }>) => posts.map((p) => p.id)

const anchor: FeedScrollAnchor = { postId: 'p45', offset: 37, scrollTop: 6000 }

function setup() {
  const store = useActivityPubStore()
  vi.spyOn(store, 'enrichFeedPosts').mockImplementation(() => {})
  const page = vi.spyOn(activityPubService, 'getUserTimeline')
  return { store, page }
}

/** A local timeline with `count` loaded posts, fetched `age` ms ago. */
function loaded(store: ReturnType<typeof useActivityPubStore>, count: number, age = 0) {
  store.localFeed.posts = range(0, count)
  store.localFeed.has_more = true
  store.localFeed.cursor = store.localFeed.posts[count - 1].created_at
  store.feedFetchedAt.local = Date.now() - age
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('useActivityPub kept timelines', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('loads the first page of a timeline never fetched', async () => {
    const { store, page } = setup()
    page.mockResolvedValue({ posts: range(0, 20), fullPage: true } as any)

    expect(store.enterTimeline('local')).toBeNull()
    await settle()

    expect(ids(store.localFeed.posts)).toEqual(ids(range(0, 20)))
    expect(store.feedFetchedAt.local).toBeGreaterThan(0)
  })

  it('keeps the loaded pages and returns the reading position left there', async () => {
    const { store, page } = setup()
    loaded(store, 80)
    page.mockResolvedValue({ posts: range(0, 20), fullPage: true } as any)

    store.leaveTimeline('local', anchor)
    expect(store.enterTimeline('local')).toEqual(anchor)
    await settle()

    expect(store.localFeed.posts).toHaveLength(80)
    expect(store.feedScroll.local).toBeNull()
    expect(store.scrolledTimeline).toBe('local')
  })

  it('queues the posts above a held position behind the pill', async () => {
    const { store, page } = setup()
    loaded(store, 80)
    page.mockResolvedValue({ posts: [post(-2), post(-1), ...range(0, 18)], fullPage: true } as any)

    store.leaveTimeline('local', anchor)
    store.enterTimeline('local')
    await settle()

    expect(store.localFeed.posts[0].id).toBe('p0')
    expect(store.localFeed.posts).toHaveLength(80)
    expect(ids(store.pendingPosts.local)).toEqual(['p-2', 'p-1'])

    store.setTimelineScrolled('local', false)
    expect(ids(store.localFeed.posts.slice(0, 3))).toEqual(['p-2', 'p-1', 'p0'])
    expect(store.localFeed.posts).toHaveLength(82)
  })

  it('puts the posts above the list in front of it when left at the top', async () => {
    const { store, page } = setup()
    loaded(store, 80)
    page.mockResolvedValue({ posts: [post(-1), ...range(0, 19)], fullPage: true } as any)

    store.leaveTimeline('local', null)
    expect(store.enterTimeline('local')).toBeNull()
    await settle()

    expect(store.localFeed.posts[0].id).toBe('p-1')
    expect(store.localFeed.posts).toHaveLength(81)
    expect(store.pendingPostCount('local')).toBe(0)
  })

  it('reloads a timeline fetched longer ago than the keep window', async () => {
    const { store, page } = setup()
    loaded(store, 80, 31 * 60 * 1000)
    page.mockResolvedValue({ posts: range(0, 20), fullPage: true } as any)

    store.leaveTimeline('local', anchor)
    expect(store.enterTimeline('local')).toBeNull()
    await settle()

    expect(store.localFeed.posts).toHaveLength(20)
  })

  it('replaces the list with a head page that does not reach it, at the top', async () => {
    const { store, page } = setup()
    loaded(store, 80)
    page.mockResolvedValue({ posts: range(-40, -20), fullPage: true } as any)

    store.enterTimeline('local')
    await settle()

    expect(ids(store.localFeed.posts)).toEqual(ids(range(-40, -20)))
    expect(store.localFeed.has_more).toBe(true)
    expect(store.localFeed.cursor).toBe(post(-21).created_at)
  })

  it('holds a head page that does not reach the list until the pill shows it', async () => {
    const { store, page } = setup()
    loaded(store, 80)
    page.mockResolvedValue({ posts: range(-40, -20), fullPage: true } as any)

    store.leaveTimeline('local', anchor)
    store.enterTimeline('local')
    await settle()

    expect(store.localFeed.posts).toHaveLength(80)
    expect(store.pendingPostCount('local')).toBe(20)

    store.setTimelineScrolled('local', false)
    expect(ids(store.localFeed.posts)).toEqual(ids(range(-40, -20)))
    expect(store.localFeed.cursor).toBe(post(-21).created_at)
    expect(store.localFeed.has_more).toBe(true)
  })

  it('queues realtime posts for a timeline left scrolled, without trimming it', async () => {
    const { store } = setup()
    loaded(store, 150)
    vi.spyOn(activityPubService, 'loadPostWithAuthor').mockResolvedValue({
      id: 'live', author_id: 'them', visibility: 'public', is_local: true, created_at: new Date().toISOString(),
    } as any)
    vi.spyOn(store, 'playNewPostSound').mockImplementation(() => {})

    store.leaveTimeline('local', anchor)
    await store.handleRealtimePostCreate({ id: 'live' })

    expect(store.localFeed.posts).toHaveLength(150)
    expect(ids(store.pendingPosts.local)).toEqual(['live'])
  })

  it('shows the queued posts when the timeline is left at the top', () => {
    const { store } = setup()
    loaded(store, 5)
    store.setTimelineScrolled('local', true)
    store.pendingPosts.local = [post(-1)]

    store.leaveTimeline('local', null)

    expect(store.scrolledTimeline).toBeNull()
    expect(store.localFeed.posts[0].id).toBe('p-1')
  })

  it('forgets positions and the draft on sign-out', () => {
    const { store } = setup()
    loaded(store, 5)
    store.leaveTimeline('local', anchor)
    store.keepComposerDraft({ content: 'unsent', contentWarning: '', sensitive: false, visibility: 'public', mediaAttachments: [] })

    store.resetUserRelationshipState()

    expect(store.feedScroll.local).toBeNull()
    expect(store.feedFetchedAt.local).toBe(0)
    expect(store.composerDraft).toBeNull()
  })
})
