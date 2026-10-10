/**
 * PostView.vue on a remote post: opening it starts a reply crawl when one is due, a row under
 * the main post follows the crawl, and the thread reloads itself when replies arrive.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { shallowMount, flushPromises } from '@vue/test-utils'

const POST_AP_ID = 'https://mastodon.test/users/strypey/statuses/1'

const service = vi.hoisted(() => ({
  fetchRemoteReplies: vi.fn(),
  getRemoteRepliesStatus: vi.fn(),
  fetchRemoteReactions: vi.fn(),
  deletePost: vi.fn(),
}))
vi.mock('@/services/activityPubService', () => ({ activityPubService: service }))

const store = vi.hoisted(() => ({ getPostWithContext: vi.fn() }))
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => store }))
vi.mock('@/stores/postReactions', () => ({ usePostReactionsStore: () => ({ fetchMultiplePostReactions: vi.fn() }) }))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {} }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn() }) }))
vi.mock('@/composables/usePostInteractions', () => ({
  usePostInteractions: () => ({ toggleFavorite: vi.fn(), toggleReblog: vi.fn(), toggleBookmark: vi.fn() }),
}))
vi.mock('@/utils/discordBridgeSetup', () => ({ resolveHarmonyBaseUrl: () => 'https://harmony.test' }))

const stub = vi.hoisted(() => (name: string) => ({ default: { name, props: ['post', 'detailed'], render: () => null } }))
vi.mock('@/components/activitypub/MonyPost.vue', () => stub('MonyPost'))
vi.mock('@/components/activitypub/Composer.vue', () => stub('Composer'))

import PostView from '../PostView.vue'

const mainPost = (extra: Record<string, unknown> = {}) => ({
  id: 'post-1',
  ap_id: POST_AP_ID,
  url: POST_AP_ID,
  is_local: false,
  created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
  replies_fetched_at: null,
  replies_count: 0,
  content: [{ type: 'text', text: 'hello' }],
  author: { id: 'author-1', username: 'strypey', domain: 'mastodon.test', is_local: false },
  metadata: {},
  ...extra,
})

const thread = (post: Record<string, unknown>, descendants: Array<Record<string, unknown>> = []) => ({
  mainPost: post,
  ancestors: [],
  descendants,
  threadInfo: { totalPosts: 1 + descendants.length, participantCount: 1, depth: 0, rootPostId: 'post-1' },
})

const crawl = (extra: Record<string, unknown> = {}) => ({
  outcome: 'ok', found: 0, stored: 0, existing: 0, skipped: 0, pages: 1, truncated: false, complete: true, ...extra,
})

const mountView = () => shallowMount(PostView, {
  props: { postId: 'post-1' },
  global: { stubs: { RemoteRepliesStatus: false } },
})

const statusRow = (wrapper: ReturnType<typeof mountView>) => wrapper.find('.remote-replies-status')

describe('PostView reply crawl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows a placeholder row while the origin is read, then reloads the thread with the replies', async () => {
    store.getPostWithContext
      .mockResolvedValueOnce(thread(mainPost()))
      .mockResolvedValueOnce(thread(mainPost({ replies_count: 2 }), [{ id: 'r1' }, { id: 'r2' }]))
    service.fetchRemoteReplies.mockResolvedValue({ success: true, status: 'started', result: null, replies_count: 0 })
    service.getRemoteRepliesStatus
      .mockResolvedValueOnce({ success: true, status: 'running', result: null })
      .mockResolvedValueOnce({ success: true, status: 'done', result: crawl({ found: 2, stored: 2 }), replies_count: 2 })

    const wrapper = mountView()
    await flushPromises()

    expect(service.fetchRemoteReplies).toHaveBeenCalledWith(POST_AP_ID, 'post-1', { force: false })
    expect(wrapper.find('[data-testid="remote-replies-fetching"]').text())
      .toContain('activitypub.repliesFetching:{"domain":"mastodon.test"}')

    await vi.advanceTimersByTimeAsync(2000)
    expect(statusRow(wrapper).exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()

    expect(store.getPostWithContext).toHaveBeenCalledTimes(2)
    expect(statusRow(wrapper).exists()).toBe(false)
    expect(wrapper.findAllComponents({ name: 'MonyPost' })).toHaveLength(3)
  })

  it('says when the origin lists no public replies', async () => {
    store.getPostWithContext.mockResolvedValue(thread(mainPost()))
    service.fetchRemoteReplies.mockResolvedValue({ success: true, status: 'done', result: crawl({ found: 0 }), replies_count: 0 })

    const wrapper = mountView()
    await flushPromises()

    expect(statusRow(wrapper).text()).toContain('activitypub.noRepliesFromSource:{"domain":"mastodon.test"}')
    expect(store.getPostWithContext).toHaveBeenCalledTimes(1)
  })

  it('shows how many replies are held and links the rest on the origin', async () => {
    store.getPostWithContext.mockResolvedValue(thread(mainPost({ replies_count: 340 })))
    service.fetchRemoteReplies.mockResolvedValue({
      success: true, status: 'done', replies_count: 340,
      result: crawl({ found: 200, stored: 0, existing: 200, truncated: true, complete: false }),
    })

    const wrapper = mountView()
    await flushPromises()

    const row = statusRow(wrapper)
    expect(row.text()).toContain('activitypub.repliesPartial:{"shown":200,"total":340,"domain":"mastodon.test"}')
    expect(row.find('a').attributes('href')).toBe(POST_AP_ID)
  })

  it('reports a rate limit with its seconds and retries on request', async () => {
    store.getPostWithContext.mockResolvedValue(thread(mainPost()))
    service.fetchRemoteReplies
      .mockResolvedValueOnce({ success: false, status: 'rate_limited', retry_after: 24 })
      .mockResolvedValueOnce({ success: true, status: 'done', result: crawl({ found: 0 }) })

    const wrapper = mountView()
    await flushPromises()

    expect(statusRow(wrapper).text()).toContain('activitypub.repliesRateLimited:{"seconds":24}')
    await statusRow(wrapper).find('button').trigger('click')
    await flushPromises()

    expect(service.fetchRemoteReplies).toHaveBeenLastCalledWith(POST_AP_ID, 'post-1', { force: true })
    expect(statusRow(wrapper).text()).toContain('activitypub.noRepliesFromSource')
  })

  it('reports an origin it cannot reach', async () => {
    store.getPostWithContext.mockResolvedValue(thread(mainPost()))
    service.fetchRemoteReplies.mockResolvedValue({ success: true, status: 'done', result: crawl({ outcome: 'unavailable', complete: false }) })

    const wrapper = mountView()
    await flushPromises()

    expect(statusRow(wrapper).text()).toContain('activitypub.fetchOlderFailed:{"domain":"mastodon.test"}')
    expect(statusRow(wrapper).find('button').exists()).toBe(true)
  })

  it('starts no crawl while the last one is recent', async () => {
    store.getPostWithContext.mockResolvedValue(thread(mainPost({ replies_fetched_at: new Date(Date.now() - 60_000).toISOString() })))

    const wrapper = mountView()
    await flushPromises()

    expect(service.fetchRemoteReplies).not.toHaveBeenCalled()
    expect(statusRow(wrapper).exists()).toBe(false)
  })

  it('starts no crawl for a local post', async () => {
    store.getPostWithContext.mockResolvedValue(thread(mainPost({ is_local: true, ap_id: 'https://harmony.test/activities/x' })))
    mountView()
    await flushPromises()
    expect(service.fetchRemoteReplies).not.toHaveBeenCalled()
  })
})
