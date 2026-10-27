/**
 * Links out of a quote post and a reply in `MonyPost.vue`.
 *
 * The quoted card opens the quoted post on a click anywhere outside its own links and
 * controls; its time is the real link, its author's avatar and name open the profile. A
 * quoted snapshot without a local id resolves its address first. The reply line is one link
 * to the parent post that carries the whole handle in its title.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, reactive, ref, computed } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  createI18n: () => ({ install: () => {}, global: { t: (key: string) => key } }),
}))

const router = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('@/router', () => ({ default: router }))

const resolver = vi.hoisted(() => ({ resolveByApUrl: vi.fn() }))
vi.mock('@/services/PostResolverService', () => ({ postResolverService: resolver }))

const openLink = vi.hoisted(() => vi.fn())
vi.mock('@/services/outsideLinks', () => ({ openLink }))

vi.mock('vue-toastification', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({
    getCurrentUser: computed(() => ({ id: 'viewer-1' })),
    getUserProfile: () => computed(() => null),
  }),
}))

vi.mock('@/composables/usePostInteractions', () => ({
  usePostInteractions: () => ({
    toggleFavorite: vi.fn(),
    toggleReblog: vi.fn(),
    toggleBookmark: vi.fn(),
    togglePinPost: vi.fn(),
  }),
}))

vi.mock('@/composables/useViewport', () => ({
  useViewport: () => ({ isTouchOnly: ref(false), isMobile: ref(false) }),
}))

vi.mock('@/composables/useRemotePostSync', () => ({
  useRemotePostSync: () => ({
    isFetchingReactions: ref(false),
    isFetchingReplies: ref(false),
    fetchRemoteReactions: vi.fn(),
    fetchRemoteReplies: vi.fn(),
  }),
}))

vi.mock('@/composables/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}))

vi.mock('@/stores/useActivityPub', () => ({
  useActivityPubStore: () => ({
    mutedUsers: new Set<string>(),
    openComposer: vi.fn(),
    deletePost: vi.fn(),
    updatePostMetadataInAllFeeds: vi.fn(),
  }),
}))

vi.mock('@/stores/useNotification', () => ({
  useNotificationStore: () => ({ showToast: vi.fn() }),
}))

vi.mock('@/stores/useTheme', () => ({
  useThemeStore: () => ({ playAudio: vi.fn() }),
}))

vi.mock('@/services/userDataService', () => ({
  userDataService: {
    getCurrentUser: () => ({ id: 'viewer-1' }),
    resolveDisplayNameParts: () => null,
  },
}))

vi.mock('@/services/ConversationService', () => ({
  default: { getConversationNavigationData: vi.fn() },
}))

vi.mock('@/services/unifiedEmojiService', () => ({
  unicodeToShortcode: () => '',
}))

vi.mock('@/services/FundingService', () => ({
  badgeFromMembership: () => null,
}))

vi.mock('@/services/AdminService', () => ({
  adminService: { refetchRemotePost: vi.fn() },
}))

import { createPinia } from 'pinia'
import MonyPost from '../MonyPost.vue'

const QUOTED_URL = 'https://stats.example/users/apps/statuses/9'

// RouterLink renders an anchor with an href, as vue-router's does.
const RouterLink = defineComponent({
  name: 'RouterLink',
  props: { to: { type: [String, Object], required: true } },
  setup(props, { slots, attrs }) {
    return () => h('a', { ...attrs, href: `#${JSON.stringify(props.to)}` }, slots.default?.())
  },
})

// Rendered content: words, a hashtag, a mention and a link, as UnifiedContentRenderer's HTML.
const MonyContent = defineComponent({
  name: 'MonyContent',
  props: ['content'],
  setup() {
    return () => h('div', { class: 'content-stub' }, [
      h('span', { class: 'words' }, 'quoted words '),
      h('span', { class: 'hashtag', 'data-tag': 'fedi' }, '#fedi'),
      h('span', { class: 'mention', 'data-user-id': 'u1' }, '@someone'),
      h('a', { href: 'https://example.com/page', class: 'outside' }, 'a page'),
    ])
  },
})

const author = { id: 'author-1', username: 'dansup', display_name: 'Daniel', avatar_url: '/a.webp', domain: 'mastodon.example', is_local: false }
const quotedAuthor = { id: 'author-2', username: 'apps', display_name: 'New fediverse apps', avatar_url: '/b.webp', domain: 'stats.example', is_local: false }

const quotePost = (reblog: Record<string, unknown> | null, metadata: Record<string, unknown> = {}) => reactive({
  id: 'quote-1',
  author_id: author.id,
  author,
  content: [{ type: 'text', text: 'Test quote post' }],
  created_at: '2026-10-20T00:00:00Z',
  visibility: 'public',
  is_local: false,
  ap_id: 'https://mastodon.example/users/dansup/statuses/1',
  favorites_count: 0,
  reblogs_count: 0,
  replies_count: 0,
  media_attachments: [],
  metadata: { is_quote: true, quote_ap_url: QUOTED_URL, ...metadata },
  reblog,
  reblog_author: reblog ? quotedAuthor : undefined,
}) as any

const snapshot = (extra: Record<string, unknown> = {}) => ({
  id: 'quoted-1',
  content: [{ type: 'text', text: 'quoted words' }],
  created_at: '2026-10-19T00:00:00Z',
  visibility: 'public',
  ...extra,
})

const mountPost = (post: any) =>
  mount(MonyPost, {
    props: { post },
    shallow: true,
    attachTo: document.body,
    global: {
      plugins: [createPinia()],
      directives: { 'click-outside': {} },
      stubs: { RouterLink, MonyContent, AppTimestamp: { template: '<time>1d</time>' } },
    },
  })

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('MonyPost quoted card', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('links the quoted author to their profile and the time to the quoted post', () => {
    const wrapper = mountPost(quotePost(snapshot()))
    const authorLink = wrapper.getComponent<typeof RouterLink>('[data-testid="quoted-author"]')
    expect(authorLink.props('to')).toEqual({ name: 'UserProfile', params: { handle: 'apps@stats.example' } })
    expect(authorLink.text()).toContain('@apps@stats.example')

    const timeLink = wrapper.getComponent<typeof RouterLink>('[data-testid="quoted-post-link"]')
    expect(timeLink.props('to')).toEqual({ name: 'PostDetail', params: { postId: 'quoted-1' } })
    expect(timeLink.attributes('aria-label')).toBe('activitypub.quoteA11y.openPost')
    // No link holds another.
    expect(wrapper.findAll('[data-testid="quoted-post"] a a')).toHaveLength(0)
    wrapper.unmount()
  })

  it('opens the quoted post from a click on its text', async () => {
    const wrapper = mountPost(quotePost(snapshot()))
    expect(wrapper.get('[data-testid="quoted-post"]').classes()).toContain('is-openable')
    await wrapper.get('[data-testid="quoted-post"] .words').trigger('click')
    expect(router.push).toHaveBeenCalledWith({ name: 'PostDetail', params: { postId: 'quoted-1' } })
    wrapper.unmount()
  })

  it('leaves hashtags, mentions, links and modified clicks to themselves', async () => {
    const wrapper = mountPost(quotePost(snapshot()))
    const card = wrapper.get('[data-testid="quoted-post"]')
    await card.get('.hashtag').trigger('click')
    await card.get('.mention').trigger('click')
    await card.get('a.outside').trigger('click')
    await card.get('[data-testid="quoted-author"]').trigger('click')
    await card.get('.words').trigger('click', { ctrlKey: true })
    await card.get('.words').trigger('click', { button: 1 })
    expect(router.push).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('names the local copy by metadata.reblog_of when the snapshot has no id', () => {
    const wrapper = mountPost(quotePost(snapshot({ id: undefined }), { reblog_of: 'quoted-2' }))
    const timeLink = wrapper.getComponent<typeof RouterLink>('[data-testid="quoted-post-link"]')
    expect(timeLink.props('to')).toEqual({ name: 'PostDetail', params: { postId: 'quoted-2' } })
    wrapper.unmount()
  })

  it('resolves a quoted post known only by its address, and opens the address when that fails', async () => {
    resolver.resolveByApUrl.mockResolvedValueOnce({ id: 'imported-1' }).mockResolvedValueOnce(null)
    const wrapper = mountPost(quotePost(snapshot({ id: undefined })))
    const timeLink = wrapper.get('[data-testid="quoted-post-link"]')
    expect(timeLink.attributes('href')).toBe(QUOTED_URL)

    await timeLink.trigger('click')
    await flush()
    expect(resolver.resolveByApUrl).toHaveBeenCalledWith(QUOTED_URL)
    expect(router.push).toHaveBeenCalledWith({ name: 'PostDetail', params: { postId: 'imported-1' } })

    await wrapper.get('[data-testid="quoted-post"] .words').trigger('click')
    await flush()
    expect(openLink).toHaveBeenCalledWith(QUOTED_URL)
    expect(router.push).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('keeps the outside link of a quote whose post was never fetched', () => {
    const wrapper = mountPost(quotePost(null))
    const link = wrapper.get('a.quoted-post-link')
    expect(link.attributes('href')).toBe(QUOTED_URL)
    expect(link.attributes('target')).toBe('_blank')
    expect(wrapper.find('[data-testid="quoted-post"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('MonyPost reply line', () => {
  const reply = () => reactive({
    id: 'reply-1',
    author_id: author.id,
    author,
    content: [{ type: 'text', text: 'a reply' }],
    created_at: '2026-10-20T00:00:00Z',
    visibility: 'public',
    is_local: false,
    favorites_count: 0,
    reblogs_count: 0,
    replies_count: 0,
    media_attachments: [],
    metadata: {},
    in_reply_to: 'parent-1',
    reply_context: {
      id: 'parent-1',
      content_preview: 'parent',
      content: [],
      author: { id: 'p1', username: 'someone', display_name: 'Someone', domain: 'a.very.long.instance.example' },
      created_at: '2026-10-19T00:00:00Z',
      visibility: 'public',
    },
  }) as any

  it('is one link to the parent post with the whole handle in its title', () => {
    const wrapper = mountPost(reply())
    const line = wrapper.getComponent<typeof RouterLink>('[data-testid="post-reply-line"]')
    expect(line.props('to')).toEqual({ name: 'PostDetail', params: { postId: 'parent-1' } })
    expect(line.attributes('title')).toBe('activitypub.replyingTo @someone@a.very.long.instance.example')
    expect(line.text()).toBe('activitypub.replyingTo @someone@a.very.long.instance.example')
    expect(line.classes()).toContain('reply-line-target')
    expect(wrapper.get('.reply-line .reply-line-thread').text()).toBe('activitypub.viewThread')
    wrapper.unmount()
  })
})
