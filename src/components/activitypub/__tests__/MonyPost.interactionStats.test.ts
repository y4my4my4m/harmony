/**
 * Focused post stats: boosts and favourites are buttons named by their visible
 * text plus "show who", opening the accounts list on their tab; replies stay
 * text. A boost's list is its original post's.
 */

import { describe, it, expect, vi } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'
import { defineComponent, reactive, ref, computed } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'

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
import PostInteractionsDialog from '../PostInteractionsDialog.vue'

const author = {
  id: 'author-1',
  username: 'alice',
  display_name: 'Alice',
  avatar_url: '/default_avatar.webp',
  domain: 'harmony.test',
  is_local: true,
}

const makePost = (counts: { replies?: number; reblogs?: number; favorites?: number }, extra: Record<string, unknown> = {}) => reactive({
  id: 'post-1',
  author_id: author.id,
  author,
  content: [{ type: 'text', text: 'hello' }],
  created_at: '2026-01-01T00:00:00Z',
  visibility: 'public',
  is_local: true,
  favorites_count: counts.favorites ?? 0,
  reblogs_count: counts.reblogs ?? 0,
  replies_count: counts.replies ?? 0,
  is_favorited: false,
  is_reblogged: false,
  is_bookmarked: false,
  ...extra,
}) as any

const mountPost = (post: any, detailed = true) =>
  mount(MonyPost, {
    props: { post, detailed },
    shallow: true,
    global: {
      plugins: [createPinia(), createI18n({ legacy: false, locale: 'en', messages: { en } })],
      directives: { 'click-outside': {} },
      stubs: { RouterLink: RouterLinkStub },
    },
  })

describe('MonyPost focused stats', () => {
  it('names the boosts and favourites buttons by their visible text and what they open', () => {
    const wrapper = mountPost(makePost({ replies: 2, reblogs: 1, favorites: 5 }))
    const boosts = wrapper.get('[data-testid="post-boosts-stat"]')
    const favorites = wrapper.get('[data-testid="post-favorites-stat"]')

    expect(boosts.element.tagName).toBe('BUTTON')
    expect(boosts.attributes('aria-label')).toBe('1 boost, show who')
    expect(boosts.text()).toBe('1 boost')
    expect(boosts.attributes('aria-haspopup')).toBe('dialog')
    expect(favorites.attributes('aria-label')).toBe('5 favorites, show who')
    expect(favorites.text()).toBe('5 favorites')

    const replies = wrapper.findAll('.detail-stat').find((el) => el.text().includes('replies'))!
    expect(replies.element.tagName).toBe('SPAN')
    expect(wrapper.find('[data-testid="post-replies-stat"]').exists()).toBe(false)
  })

  it('uses the shortened count in the name, as shown', () => {
    const wrapper = mountPost(makePost({ favorites: 1234 }))
    expect(wrapper.get('[data-testid="post-favorites-stat"]').attributes('aria-label')).toBe('1.2K favorites, show who')
  })

  it('opens the list on the tab of the stat clicked and closes it on close', async () => {
    const wrapper = mountPost(makePost({ reblogs: 3, favorites: 7 }))
    expect(wrapper.findComponent(PostInteractionsDialog).exists()).toBe(false)

    await wrapper.get('[data-testid="post-favorites-stat"]').trigger('click')
    const dialog = wrapper.findComponent(PostInteractionsDialog)
    expect(dialog.props()).toEqual({ postId: 'post-1', initialTab: 'favorite', favoritesCount: 7, boostsCount: 3 })

    dialog.vm.$emit('close')
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent(PostInteractionsDialog).exists()).toBe(false)

    await wrapper.get('[data-testid="post-boosts-stat"]').trigger('click')
    expect(wrapper.findComponent(PostInteractionsDialog).props('initialTab')).toBe('reblog')
  })

  it("lists a boost's original post", async () => {
    const original = makePost({ reblogs: 4, favorites: 2 })
    original.id = 'original-1'
    const boost = makePost({}, {
      id: 'boost-1',
      content: [],
      reblog: original,
      reblog_author: author,
      metadata: { is_reblog: true },
    })
    const wrapper = mountPost(boost)
    await wrapper.get('[data-testid="post-boosts-stat"]').trigger('click')
    expect(wrapper.findComponent(PostInteractionsDialog).props()).toMatchObject({
      postId: 'original-1',
      favoritesCount: 2,
      boostsCount: 4,
    })
  })

  it('keeps the stats out of feed posts', () => {
    const wrapper = mountPost(makePost({ reblogs: 3, favorites: 7 }), false)
    expect(wrapper.find('[data-testid="post-favorites-stat"]').exists()).toBe(false)
  })
})
