/**
 * Posts tab of TrendingContent.vue: cursor paging, hidden-author pages, request races
 * and URL state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

const service = vi.hoisted(() => ({
  getTrendingPosts: vi.fn(),
  getTrendingHashtags: vi.fn(async () => []),
  getTrendingUsers: vi.fn(async () => []),
  getFederatedInstances: vi.fn(async () => []),
}))
vi.mock('@/services/TrendingService', () => ({
  trendingService: service,
  TRENDING_TIME_RANGE_HOURS: { '1h': 1, '6h': 6, '24h': 24, '7d': 168, '30d': 720 },
}))

const store = vi.hoisted(() => ({
  mutedUsers: new Set<string>(),
  blockedUsers: new Set<string>(),
  $onAction: vi.fn(),
  enrichFeedPosts: vi.fn(),
}))
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => store }))
vi.mock('@/stores/useInstanceSettings', () => ({
  useInstanceSettingsStore: () => ({ isFederationEnabled: true }),
}))

const stub = vi.hoisted(() => (name: string) => ({
  name,
  props: { posts: Array, hasMore: Boolean, isLoading: Boolean },
  render: () => null,
}))
vi.mock('@/components/common/PostsContainer.vue', () => ({ default: stub('PostsContainer') }))
vi.mock('@/components/common/ProfileCard.vue', () => ({ default: stub('ProfileCard') }))
vi.mock('@/components/common/Icon.vue', () => ({ default: stub('Icon') }))
vi.mock('@/components/common/LoadingSpinner.vue', () => ({ default: stub('LoadingSpinner') }))
vi.mock('@/components/activitypub/Composer.vue', () => ({ default: stub('Composer') }))

import TrendingContent from '../TrendingContent.vue'

const post = (id: string, author = 'a1') => ({ id, author_id: author, author: { id: author } })
const cursorOf = (id: string) => ({ score: 1, createdAt: `t-${id}`, id })
const page = (ids: string[], hasMore: boolean, author = 'a1') => ({
  posts: ids.map(id => post(id, author)),
  asOf: 'AS_OF',
  cursor: ids.length ? cursorOf(ids[ids.length - 1]) : null,
  hasMore,
})

async function setup(path = '/social/trending') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/social/trending', name: 'SocialTrending', component: { render: () => null } },
      { path: '/social/:timeline', name: 'Social', component: { render: () => null } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(TrendingContent, { global: { plugins: [router] } })
  await flushPromises()
  const list = () => wrapper.findComponent({ name: 'PostsContainer' })
  return { router, wrapper, list }
}

describe('TrendingContent posts', () => {
  beforeEach(() => {
    service.getTrendingPosts.mockReset()
    store.blockedUsers.clear()
    store.enrichFeedPosts.mockReset()
  })

  it('pages after the previous page with its cursor and as_of', async () => {
    service.getTrendingPosts
      .mockResolvedValueOnce(page(['p1', 'p2'], true))
      .mockResolvedValueOnce(page(['p3'], false))
    const { list } = await setup('/social/trending?range=7d&media=1&source=r.test')

    expect(service.getTrendingPosts).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeRange: '7d', mediaOnly: true, localOnly: false, domain: 'r.test' }),
    )
    list().vm.$emit('load-more')
    await flushPromises()

    expect(service.getTrendingPosts).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeRange: '7d', asOf: 'AS_OF', after: cursorOf('p2') }),
    )
    expect((list().props('posts') as any[]).map(p => p.id)).toEqual(['p1', 'p2', 'p3'])
    expect(list().props('hasMore')).toBe(false)
    expect(store.enrichFeedPosts).toHaveBeenCalledTimes(2)
  })

  it('continues past a page whose authors are all hidden', async () => {
    store.blockedUsers.add('blocked')
    service.getTrendingPosts
      .mockResolvedValueOnce(page(['b1', 'b2'], true, 'blocked'))
      .mockResolvedValueOnce(page(['p3'], false))
    const { list } = await setup()

    expect(service.getTrendingPosts).toHaveBeenCalledTimes(2)
    expect((list().props('posts') as any[]).map(p => p.id)).toEqual(['p3'])
    expect(list().props('isLoading')).toBe(false)
  })

  it('drops a response that a newer filter superseded', async () => {
    let resolveFirst!: (v: unknown) => void
    service.getTrendingPosts
      .mockImplementationOnce(() => new Promise(r => { resolveFirst = r }))
      .mockResolvedValueOnce(page(['week'], false))
    const { router, list } = await setup()

    await router.replace({ query: { range: '7d' } })
    await flushPromises()
    resolveFirst(page(['day'], false))
    await flushPromises()

    expect((list().props('posts') as any[]).map(p => p.id)).toEqual(['week'])
  })

  it('records tab changes in history and replaces the entry for filters', async () => {
    service.getTrendingPosts.mockResolvedValue(page(['p1'], false))
    const { router, wrapper } = await setup()
    const push = vi.spyOn(router, 'push')
    const replace = vi.spyOn(router, 'replace')

    await wrapper.find('[data-testid="trending-tab-hashtags"]').trigger('click')
    await flushPromises()
    expect(push).toHaveBeenCalledWith({ query: { tab: 'hashtags' } })

    const select = wrapper.find('[data-testid="trending-range"]')
    ;(select.element as HTMLSelectElement).value = '7d'
    await select.trigger('change')
    expect(replace).toHaveBeenCalledWith({ query: { tab: 'hashtags', range: '7d' } })
  })
})
