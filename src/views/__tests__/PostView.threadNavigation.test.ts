/**
 * PostView.vue across post links: the view is reused for every /social/post/:postId, so a
 * link to another post (a timestamp in the thread, a notification) loads that post's thread,
 * and a load a newer one supersedes leaves no trace. A reply's page offers the page of its
 * conversation's top post, with the reply highlighted, when that page shows more.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shallowMount, flushPromises, RouterLinkStub } from '@vue/test-utils'
import { reactive } from 'vue'

vi.mock('@/services/activityPubService', () => ({
  activityPubService: { fetchRemoteReplies: vi.fn(), getRemoteRepliesStatus: vi.fn(), fetchRemoteReactions: vi.fn(), deletePost: vi.fn() },
}))

const store = vi.hoisted(() => ({ getPostWithContext: vi.fn() }))
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => store }))
vi.mock('@/stores/postReactions', () => ({ usePostReactionsStore: () => ({ fetchMultiplePostReactions: vi.fn() }) }))

vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }) }))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}))

const route = vi.hoisted(() => ({ current: null as null | { params: Record<string, string>; query: Record<string, string> } }))
vi.mock('vue-router', () => ({
  useRoute: () => route.current,
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

const post = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  is_local: true,
  ap_id: `https://harmony.test/activities/${id}`,
  created_at: '2026-10-20T00:00:00Z',
  replies_count: 0,
  content: [{ type: 'text', text: id }],
  author: { id: 'author-1', username: 'ana', domain: 'harmony.test', is_local: true },
  metadata: {},
  ...extra,
})

const thread = (
  main: string,
  { ancestors = [] as string[], descendants = [] as string[], total, root }: { ancestors?: string[]; descendants?: string[]; total?: number; root?: string } = {},
) => ({
  mainPost: post(main),
  ancestors: ancestors.map((id) => post(id)),
  descendants: descendants.map((id) => post(id)),
  threadInfo: {
    totalPosts: total ?? ancestors.length + 1 + descendants.length,
    participantCount: 1,
    depth: 0,
    rootPostId: root ?? ancestors[0] ?? main,
  },
})

const mountView = () => shallowMount(PostView, { global: { stubs: { RouterLink: RouterLinkStub } } })

const shownIds = (wrapper: ReturnType<typeof mountView>) =>
  wrapper.findAllComponents({ name: 'MonyPost' }).map((c) => (c.props('post') as { id: string }).id)

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('PostView post links', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    route.current = reactive({ params: { postId: 'reply-1' }, query: {} })
  })

  it('loads the linked post when the route names another one', async () => {
    store.getPostWithContext
      .mockResolvedValueOnce(thread('reply-1', { ancestors: ['root-1'], descendants: ['reply-1a'], total: 5 }))
      .mockResolvedValueOnce(thread('root-1', { descendants: ['reply-1', 'reply-1a', 'reply-2', 'reply-3'] }))

    const wrapper = mountView()
    await flushPromises()
    expect(store.getPostWithContext).toHaveBeenLastCalledWith('reply-1', expect.objectContaining({ context: 'thread' }))
    expect(shownIds(wrapper)).toEqual(['root-1', 'reply-1', 'reply-1a'])

    route.current!.params.postId = 'root-1'
    await flushPromises()

    expect(store.getPostWithContext).toHaveBeenCalledTimes(2)
    expect(store.getPostWithContext).toHaveBeenLastCalledWith('root-1', expect.objectContaining({ context: 'thread' }))
    expect(shownIds(wrapper)).toEqual(['root-1', 'reply-1', 'reply-1a', 'reply-2', 'reply-3'])
  })

  it('loads once when a link changes the post and the highlight together', async () => {
    store.getPostWithContext.mockResolvedValue(thread('reply-1'))
    const wrapper = mountView()
    await flushPromises()

    store.getPostWithContext.mockResolvedValue(thread('root-1', { descendants: ['reply-1'] }))
    route.current!.params.postId = 'root-1'
    await wrapper.setProps({ highlightReply: 'reply-1' })
    await flushPromises()

    expect(store.getPostWithContext).toHaveBeenCalledTimes(2)
  })

  it('drops the result of a load a newer one superseded', async () => {
    const slow = deferred<ReturnType<typeof thread>>()
    store.getPostWithContext
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(thread('root-1', { descendants: ['reply-1', 'reply-2'] }))

    const wrapper = mountView()
    route.current!.params.postId = 'root-1'
    await flushPromises()
    slow.resolve(thread('reply-1', { ancestors: ['root-1'] }))
    await flushPromises()

    expect(shownIds(wrapper)).toEqual(['root-1', 'reply-1', 'reply-2'])
    expect(wrapper.find('.loading-state').exists()).toBe(false)
  })
})

describe('PostView conversation bar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    route.current = reactive({ params: { postId: 'reply-1' }, query: {} })
  })

  const bar = (wrapper: ReturnType<typeof mountView>) => wrapper.find('[data-testid="post-view-conversation-bar"]')

  it('links a reply to its conversation with the reply highlighted', async () => {
    store.getPostWithContext.mockResolvedValue(thread('reply-1', { ancestors: ['root-1'], total: 6 }))
    const wrapper = mountView()
    await flushPromises()

    expect(bar(wrapper).text()).toContain('activitypub.threadA11y.inConversation:{"count":6}')
    const link = wrapper.getComponent(RouterLinkStub)
    expect(link.props('to')).toEqual({ name: 'PostDetail', params: { postId: 'root-1' }, query: { highlight: 'reply-1' } })
    expect(link.text()).toBe('activitypub.threadA11y.fullConversation')
  })

  it('leaves it out on the top post and when the page already shows the whole conversation', async () => {
    store.getPostWithContext.mockResolvedValueOnce(thread('root-1', { descendants: ['reply-1'], total: 2 }))
    route.current = reactive({ params: { postId: 'root-1' }, query: {} })
    const top = mountView()
    await flushPromises()
    expect(bar(top).exists()).toBe(false)

    store.getPostWithContext.mockResolvedValueOnce(thread('reply-1', { ancestors: ['root-1'], total: 2 }))
    route.current = reactive({ params: { postId: 'reply-1' }, query: {} })
    const whole = mountView()
    await flushPromises()
    expect(bar(whole).exists()).toBe(false)
  })

  it('offers a remote top post, whose origin may list more replies', async () => {
    const remote = thread('reply-1', { ancestors: ['root-1'], total: 2 })
    remote.ancestors[0] = { ...remote.ancestors[0], is_local: false }
    store.getPostWithContext.mockResolvedValue(remote)
    const wrapper = mountView()
    await flushPromises()
    expect(bar(wrapper).exists()).toBe(true)
  })

  it('goes to the root when the ancestors stop at the depth limit', async () => {
    const ancestors = Array.from({ length: 11 }, (_, i) => `a-${i}`)
    store.getPostWithContext.mockResolvedValue(thread('reply-1', { ancestors, total: 20, root: 'root-0' }))
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toEqual({
      name: 'PostDetail', params: { postId: 'root-0' }, query: { highlight: 'reply-1' },
    })
  })
})
