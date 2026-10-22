/**
 * A post's link preview of an X, Instagram or Bluesky post renders outside the link that
 * wraps other link cards: its players and buttons cannot sit inside an anchor. Other
 * previews, and post previews beside an attachment (the thumbnail card), keep the link.
 */

import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, reactive, ref, computed } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  createI18n: () => ({ install: () => {}, global: { t: (key: string) => key } }),
}))

vi.mock('@/router', () => ({ default: { push: vi.fn() } }))

vi.mock('vue-toastification', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

vi.mock('vue-easy-lightbox', () => ({
  default: defineComponent({ name: 'VueEasyLightbox', render: () => null }),
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
    muteUser: vi.fn(),
    unmuteUser: vi.fn(),
    blockUser: vi.fn(),
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
  default: { getConversation: vi.fn() },
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

const post = (embeds: Record<string, unknown>, media_attachments: unknown[] = []) => reactive({
  id: 'post-1',
  author_id: 'local-1',
  author: { id: 'local-1', username: 'ana', display_name: 'Ana', avatar_url: '/default_avatar.webp', domain: null, is_local: true },
  content: [{ type: 'text', text: 'links' }],
  created_at: '2026-01-01T00:00:00Z',
  visibility: 'public',
  is_local: true,
  favorites_count: 0,
  reblogs_count: 0,
  replies_count: 0,
  media_attachments,
  metadata: { embeds },
}) as any

const mountPost = (value: any) =>
  mount(MonyPost, {
    props: { post: value },
    shallow: true,
    global: {
      plugins: [createPinia()],
      directives: { 'click-outside': {} },
    },
  })

const TWEET = {
  url: 'https://x.com/NASA/status/1',
  title: 'NASA (@NASA)',
  provider: 'x',
  media: [{ type: 'image', url: 'https://pbs.twimg.com/media/A.jpg' }],
  social: { platform: 'x', url: 'https://x.com/NASA/status/1', author: { name: 'NASA', handle: '@NASA' } },
}
const ARTICLE = { url: 'https://example.com/article', title: 'Article' }

const wrapperOf = (card: any) => card.element.parentElement as HTMLElement

describe('MonyPost post previews', () => {
  it('renders a post preview outside the link, other cards inside it', () => {
    const wrapper = mountPost(post({ a: TWEET, b: ARTICLE }))
    const cards = wrapper.findAllComponents({ name: 'LinkEmbedCard' })
    expect(cards.map((c: any) => c.props('payload').url)).toEqual([TWEET.url, ARTICLE.url])
    expect(cards[0].props('variant')).toBe('default')
    expect(wrapperOf(cards[0]).tagName).toBe('DIV')
    expect(wrapperOf(cards[1]).tagName).toBe('A')
    expect(wrapperOf(cards[1]).getAttribute('href')).toBe(ARTICLE.url)
  })

  it('keeps the link around the thumbnail card of a post with an attachment', () => {
    const wrapper = mountPost(post({ a: TWEET }, [{ id: 'm1', type: 'image', url: 'https://cdn.example/a.png' }]))
    const card = wrapper.findComponent({ name: 'LinkEmbedCard' })
    expect(card.props('variant')).toBe('thumbnail')
    expect(wrapperOf(card).tagName).toBe('A')
  })
})
