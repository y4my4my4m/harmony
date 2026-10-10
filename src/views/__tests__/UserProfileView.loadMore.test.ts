/**
 * UserProfileView.vue "load more": each page is the stored posts older than the last
 * one listed, keyset (created_at, id); a remote account's outbox is imported only once
 * nothing older is stored, and paging continues past 100 posts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'

const HANDLE = 'alice@mastodon.test'

const service = vi.hoisted(() => ({
  getUserByHandle: vi.fn(),
  refreshRemoteProfile: vi.fn(async () => null),
  getUserPosts: vi.fn(),
  importRemoteOutboxPage: vi.fn(),
  countProfileMedia: vi.fn(async () => 0),
  getFollowing: vi.fn(async () => []),
  getFollowers: vi.fn(async () => []),
}))
vi.mock('@/services/activityPubService', () => ({ activityPubService: service }))
const getPinnedPosts = vi.hoisted(() => vi.fn(async () => [] as any[]))
vi.mock('@/services', () => ({
  services: {
    posts: { getPinnedPosts },
    interactions: { getUserRelationships: vi.fn(async () => ({})) },
  },
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { handle: HANDLE }, path: `/social/profile/${HANDLE}` }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('pinia', async (importOriginal) => ({
  ...(await importOriginal<typeof import('pinia')>()),
  storeToRefs: (store: any) => store,
}))
vi.mock('@/stores/useActivityPub', async () => {
  const { ref } = await import('vue')
  const store = {
    blockedUsers: ref(new Set<string>()),
    mutedUsers: ref(new Set<string>()),
    isFollowing: () => false,
    initialize: vi.fn(async () => {}),
    batchFetchRemoteReactions: vi.fn(),
  }
  return { useActivityPubStore: () => store }
})
vi.mock('@/stores/postReactions', () => ({ usePostReactionsStore: () => ({ fetchMultiplePostReactions: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'me' } } }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({}) }))
vi.mock('@/composables/useUserData', async () => {
  const { ref } = await import('vue')
  return { useUserData: () => ({ getUserBannerUrl: () => ref(null) }) }
})
vi.mock('@/composables/useFeedRealtime', () => ({ useFeedRealtime: vi.fn() }))
vi.mock('@/composables/useMovedAccount', async () => {
  const { ref } = await import('vue')
  return { useMovedAccount: () => ({ movedTo: ref(null), isMoved: ref(false) }) }
})

const stub = vi.hoisted(() => (name: string) => ({
  default: { name, props: ['posts', 'post', 'hasMore', 'isLoading', 'domain', 'profileUrl', 'subtitle', 'title'], render: () => null },
}))
vi.mock('@/components/activitypub/MonyPost.vue', () => stub('MonyPost'))
vi.mock('@/components/common/PostsContainer.vue', () => stub('PostsContainer'))
vi.mock('@/components/activitypub/ProfileMediaGrid.vue', () => stub('ProfileMediaGrid'))
vi.mock('@/components/common/ProfileCard.vue', () => stub('ProfileCard'))
vi.mock('@/components/UserProfileModal.vue', () => stub('UserProfileModal'))
vi.mock('@/components/moderation/ReportModal.vue', () => stub('ReportModal'))
vi.mock('@/components/activitypub/MonyContent.vue', () => stub('MonyContent'))
vi.mock('@/components/common/BannerImage.vue', () => stub('BannerImage'))

import UserProfileView from '../UserProfileView.vue'

const remoteRow = {
  id: 'alice-id',
  username: 'alice',
  domain: 'mastodon.test',
  handle: `@${HANDLE}`,
  display_name: 'Alice',
  is_local: false,
  federated_id: 'https://mastodon.test/users/alice',
  outbox_url: 'https://mastodon.test/users/alice/outbox',
  posts_count: 0,
  followers_count: 0,
  following_count: 0,
  created_at: '2020-01-01T00:00:00Z',
}

/**
 * The posts table, newest first. Posts 2k-1 and 2k share a created_at, ordered by id
 * descending, so every 20-post page boundary falls inside a tie.
 */
let stored: any[] = []
const post = (n: number) => ({
  id: `p${String(9999 - n).padStart(4, '0')}`,
  ap_id: `https://mastodon.test/users/alice/statuses/${n}`,
  created_at: new Date(Date.UTC(2026, 0, 1) - Math.floor((n + 1) / 2) * 60_000).toISOString(),
  content: [],
})
const seed = (from: number, to: number) => {
  for (let n = from; n < to; n++) stored.push(post(n))
}

/** getUserPosts against `stored`, keyset (created_at, id) descending. */
function keysetRead(_id: string, opts: { limit?: number; before?: string; beforeId?: string } = {}) {
  const rows = stored.filter((p) => {
    if (!opts.before) return true
    if (p.created_at < opts.before) return true
    return !!opts.beforeId && p.created_at === opts.before && p.id < opts.beforeId
  })
  return Promise.resolve(rows.slice(0, opts.limit ?? 20))
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

let wrapper: VueWrapper | null = null
const listed = () => wrapper!.findComponent({ name: 'PostsContainer' }).props('posts') as any[]
const hasMore = () => wrapper!.findComponent({ name: 'PostsContainer' }).props('hasMore') as boolean
const loadMore = async () => {
  wrapper!.findComponent({ name: 'PostsContainer' }).vm.$emit('load-more')
  await settle()
}

beforeEach(() => {
  stored = []
  service.getUserByHandle.mockResolvedValue({ ...remoteRow })
  service.getUserPosts.mockImplementation(keysetRead)
  service.importRemoteOutboxPage.mockReset()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.clearAllMocks()
})

const mountView = async () => {
  wrapper = shallowMount(UserProfileView, {
    global: { stubs: { teleport: true, RouterLink: true }, directives: { clickOutside: {} } },
  })
  await settle()
}

describe('UserProfileView load more', () => {
  it('pages a remote account past 100 posts by keyset, importing the outbox only when nothing older is stored', async () => {
    seed(0, 130)
    service.importRemoteOutboxPage.mockImplementation(async () => {
      seed(130, 150)
      return { hasMore: false, oldestId: post(149).ap_id }
    })
    await mountView()
    expect(listed()).toHaveLength(20)

    for (let i = 0; i < 6; i++) await loadMore()
    expect(listed()).toHaveLength(130)
    expect(service.importRemoteOutboxPage).not.toHaveBeenCalled()

    const last = listed()[19]
    expect(service.getUserPosts).toHaveBeenCalledWith('alice-id', { limit: 20, before: last.created_at, beforeId: last.id })
    expect(service.getUserPosts).not.toHaveBeenCalledWith('alice-id', expect.objectContaining({ limit: 100 }))

    await loadMore()
    expect(service.importRemoteOutboxPage).toHaveBeenCalledTimes(1)
    expect(service.importRemoteOutboxPage).toHaveBeenCalledWith('alice-id', remoteRow.outbox_url, {
      maxId: post(129).ap_id,
      limit: 20,
    })
    expect(listed()).toHaveLength(150)
    expect(listed().map((p) => p.id)).toEqual(stored.map((p) => p.id))
    expect(hasMore()).toBe(true)

    await loadMore()
    expect(service.importRemoteOutboxPage).toHaveBeenCalledTimes(2)
    expect(hasMore()).toBe(false)
  })

  it('keeps no duplicate when posts share a created_at across a page boundary', async () => {
    seed(0, 41)
    service.importRemoteOutboxPage.mockResolvedValue({ hasMore: false, oldestId: null })
    await mountView()
    await loadMore()
    await loadMore()
    const ids = listed().map((p) => p.id)
    expect(ids).toHaveLength(41)
    expect(new Set(ids).size).toBe(41)
  })

  it('stops after outbox imports that surface nothing older', async () => {
    seed(0, 20)
    service.importRemoteOutboxPage.mockResolvedValue({ hasMore: true, oldestId: null })
    await mountView()

    for (let i = 0; i < 5; i++) await loadMore()
    expect(service.importRemoteOutboxPage).toHaveBeenCalledTimes(3)
    expect(hasMore()).toBe(false)
  })

  it('pages a local account from the database alone', async () => {
    service.getUserByHandle.mockResolvedValue({ ...remoteRow, is_local: true, domain: 'harmony.test', outbox_url: null })
    seed(0, 45)
    await mountView()

    await loadMore()
    await loadMore()
    expect(listed()).toHaveLength(45)
    expect(hasMore()).toBe(false)
    expect(service.importRemoteOutboxPage).not.toHaveBeenCalled()
  })

  it('lists the pinned posts apart, ahead of the timeline', async () => {
    seed(0, 20)
    getPinnedPosts.mockResolvedValue([stored[5]])
    await mountView()

    const pinned = wrapper!.findAllComponents({ name: 'MonyPost' })
    expect(pinned.map((c) => c.props('post').id)).toEqual([stored[5].id])
    expect(listed().map((p) => p.id)).not.toContain(stored[5].id)
  })
})
