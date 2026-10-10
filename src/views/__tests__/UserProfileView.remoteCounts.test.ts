/**
 * UserProfileView.vue on a remote account: the header and tabs show the origin's totals
 * once /lookup-user has read them, a withheld total shows as hidden, and the Following
 * and Followers tabs say their lists hold only the accounts this instance knows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'

const HANDLE = 'strypey@mastodon.nzoss.nz'

const service = vi.hoisted(() => ({
  getUserByHandle: vi.fn(),
  refreshRemoteProfile: vi.fn(),
  getUserPosts: vi.fn(async () => []),
  countProfileMedia: vi.fn(async () => 0),
  getFollowing: vi.fn(async () => []),
  getFollowers: vi.fn(async () => []),
}))
vi.mock('@/services/activityPubService', () => ({ activityPubService: service }))
vi.mock('@/services', () => ({
  services: {
    posts: { getPinnedPosts: vi.fn(async () => []) },
    interactions: { getUserRelationships: vi.fn(async () => ({})) },
  },
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
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

const stub = vi.hoisted(() => (name: string) => ({ default: { name, props: ['domain', 'profileUrl', 'subtitle', 'title'], render: () => null } }))
vi.mock('@/components/activitypub/MonyPost.vue', () => stub('MonyPost'))
vi.mock('@/components/common/PostsContainer.vue', () => stub('PostsContainer'))
vi.mock('@/components/activitypub/ProfileMediaGrid.vue', () => stub('ProfileMediaGrid'))
vi.mock('@/components/common/ProfileCard.vue', () => stub('ProfileCard'))
vi.mock('@/components/UserProfileModal.vue', () => stub('UserProfileModal'))
vi.mock('@/components/moderation/ReportModal.vue', () => stub('ReportModal'))
vi.mock('@/components/activitypub/MonyContent.vue', () => stub('MonyContent'))
vi.mock('@/components/common/BannerImage.vue', () => stub('BannerImage'))

import UserProfileView from '../UserProfileView.vue'
import RemoteListNote from '@/components/activitypub/RemoteListNote.vue'
import ViewHeader from '@/components/common/ViewHeader.vue'

/** As stored before its totals were read: one local follower, nothing else. */
const storedRow = {
  id: 'strypey-id',
  username: 'strypey',
  domain: 'mastodon.nzoss.nz',
  handle: `@${HANDLE}`,
  display_name: 'Strypey',
  is_local: false,
  federated_id: 'https://mastodon.nzoss.nz/users/strypey',
  outbox_url: 'https://mastodon.nzoss.nz/users/strypey/outbox',
  posts_count: 0,
  followers_count: 1,
  following_count: 0,
  created_at: '2018-01-01T00:00:00Z',
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

const tabCounts = (wrapper: VueWrapper) =>
  wrapper.findAll('.tab-btn').map((tab) => tab.find('.tab-count').exists() ? tab.find('.tab-count').text() : '')

let wrapper: VueWrapper | null = null

const mountView = async () => {
  wrapper = shallowMount(UserProfileView, {
    global: {
      stubs: { teleport: true, RouterLink: true, RemoteListNote: false, ViewHeader: false },
      directives: { clickOutside: {} },
    },
  })
  await settle()
  return wrapper
}

beforeEach(() => {
  service.getUserByHandle.mockResolvedValue({ ...storedRow })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.clearAllMocks()
})

describe('UserProfileView on a remote account', () => {
  it('shows the origin totals /lookup-user read, not the local counters', async () => {
    service.refreshRemoteProfile.mockResolvedValue({
      user: {
        ...storedRow,
        remote_posts_count: 15230,
        remote_followers_count: 2104,
        remote_following_count: 987,
        remote_counts_fetched_at: '2026-10-10T12:00:00Z',
      },
      backfilling: false,
    })
    const view = await mountView()

    expect(service.refreshRemoteProfile).toHaveBeenCalledWith(HANDLE)
    expect(tabCounts(view)).toEqual(['15230', '0', '987', '2104'])
    expect(view.findComponent(ViewHeader).props('subtitle')).toContain('"count":15230')
  })

  it('shows a withheld total as hidden', async () => {
    service.refreshRemoteProfile.mockResolvedValue({
      user: {
        ...storedRow,
        remote_posts_count: 15230,
        remote_followers_count: null,
        remote_following_count: null,
        remote_counts_fetched_at: '2026-10-10T12:00:00Z',
      },
      backfilling: false,
    })
    const view = await mountView()

    expect(tabCounts(view)).toEqual(['15230', '0', '–', '–'])
    expect(view.find('.tab-count-hidden').attributes('title')).toBe('activitypub.countHiddenBy:{"domain":"mastodon.nzoss.nz"}')
  })

  it('keeps the local counters while the totals are unread', async () => {
    service.refreshRemoteProfile.mockResolvedValue(null)
    const view = await mountView()
    expect(tabCounts(view)).toEqual(['0', '0', '0', '1'])
  })

  it('notes that the lists hold only accounts known here, with a link to the original profile', async () => {
    service.refreshRemoteProfile.mockResolvedValue(null)
    const view = await mountView()

    for (const index of [2, 3]) {
      await view.findAll('.tab-btn')[index].trigger('click')
      const note = view.findComponent(RemoteListNote)
      expect(note.exists()).toBe(true)
      expect(note.props('domain')).toBe('mastodon.nzoss.nz')
      expect(note.props('profileUrl')).toBe('https://mastodon.nzoss.nz/users/strypey')
    }
  })

  it('reads the posts again when the backend starts an outbox backfill', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    service.getUserPosts.mockResolvedValue([{ id: 'p1', created_at: '2026-10-01T00:00:00Z' }] as any)
    service.refreshRemoteProfile.mockResolvedValue({ user: { ...storedRow }, backfilling: true })
    try {
      wrapper = shallowMount(UserProfileView, {
        global: { stubs: { teleport: true, RouterLink: true }, directives: { clickOutside: {} } },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(service.getUserPosts).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(4000)
      expect(service.getUserPosts).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('UserProfileView on a local account', () => {
  it('lists without the note', async () => {
    service.getUserByHandle.mockResolvedValue({ ...storedRow, is_local: true, domain: 'harmony.test', followers_count: 5 })
    const view = await mountView()
    expect(service.refreshRemoteProfile).not.toHaveBeenCalled()
    await view.findAll('.tab-btn')[3].trigger('click')
    expect(view.findComponent(RemoteListNote).exists()).toBe(false)
    expect(tabCounts(view)[3]).toBe('5')
  })
})
