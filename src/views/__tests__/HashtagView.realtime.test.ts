/**
 * HashtagView.vue realtime: the tag timeline is ordered and paged by tag time
 * (post_hashtags.created_at), so a post tagged now lists first whatever its own date.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { useFeedRealtime } from '@/composables/useFeedRealtime'

const trending = vi.hoisted(() => ({
  getPostsByHashtag: vi.fn(),
  getHashtagStats: vi.fn(async () => null),
}))
vi.mock('@/services/TrendingService', () => ({ trendingService: trending }))
const loadPostWithAuthor = vi.hoisted(() => vi.fn())
vi.mock('@/services/activityPubService', () => ({ activityPubService: { loadPostWithAuthor } }))
vi.mock('@/composables/useFeedRealtime', () => ({ useFeedRealtime: vi.fn() }))
vi.mock('@/composables/usePostInteractions', () => ({ usePostInteractions: () => ({}) }))
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => ({}) }))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const stub = vi.hoisted(() => (name: string) => ({
  default: { name, props: ['posts', 'hasMore', 'isLoading', 'title', 'subtitle'], render: () => null },
}))
vi.mock('@/components/common/PostsContainer.vue', () => stub('PostsContainer'))
vi.mock('@/components/common/ViewHeader.vue', () => stub('ViewHeader'))

import HashtagView from '../HashtagView.vue'

const post = (n: number, createdAt: string) => ({ id: `p${n}`, created_at: createdAt, content: [] })

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.clearAllMocks()
})

describe('HashtagView realtime', () => {
  it('lists a newly tagged post first, though its date is older than a full first page', async () => {
    const page = Array.from({ length: 20 }, (_, i) => post(i, new Date(Date.UTC(2026, 9, 20) - i * 60_000).toISOString()))
    trending.getPostsByHashtag.mockResolvedValue({ posts: page, hasMore: true, cursor: 'c1' })
    wrapper = shallowMount(HashtagView, { props: { hashtag: 'harmony' } })
    await settle()

    const { onCreate } = vi.mocked(useFeedRealtime).mock.calls[0][1] as { onCreate: (e: { id: string }) => Promise<void> }
    const backfilled = post(99, '2020-01-01T00:00:00Z')
    loadPostWithAuthor.mockResolvedValue(backfilled)
    // Two deliveries of one event race through the load; the post lists once.
    await Promise.all([onCreate({ id: backfilled.id }), onCreate({ id: backfilled.id })])

    const listed = wrapper.findComponent({ name: 'PostsContainer' }).props('posts') as Array<{ id: string }>
    expect(listed.map((p) => p.id)).toEqual(['p99', ...page.map((p) => p.id)])
  })
})
