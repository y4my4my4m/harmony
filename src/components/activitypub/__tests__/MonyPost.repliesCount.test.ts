/**
 * Reply counter reconciliation for `MonyPost.vue`.
 *
 * Sending an inline reply bumps `repliesCountOverride` optimistically. The
 * override must yield again once the server value on the post changes,
 * otherwise the rendered count is pinned to the local guess for the life of
 * the component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
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

import MonyPost from '../MonyPost.vue'

// Feed posts are store-owned reactive objects; the store rewrites counts in
// place rather than replacing the object.
const makePost = (repliesCount: number, id = 'post-1') => reactive({
  id,
  author_id: 'author-1',
  author: {
    id: 'author-1',
    username: 'alice',
    display_name: 'Alice',
    avatar_url: '/default_avatar.webp',
    domain: 'harmony.test',
    is_local: true,
  },
  content: [{ type: 'text', text: 'hello' }],
  created_at: '2026-01-01T00:00:00Z',
  visibility: 'public',
  is_local: true,
  favorites_count: 0,
  reblogs_count: 0,
  replies_count: repliesCount,
  is_favorited: false,
  is_reblogged: false,
  is_bookmarked: false,
}) as any

const mountPost = (post: any) =>
  mount(MonyPost, {
    props: { post },
    shallow: true,
    global: {
      directives: { 'click-outside': {} },
    },
  })

const replyCountText = (wrapper: any) => wrapper.get('[data-testid="post-reply-btn"]').text().trim()

describe('MonyPost reply counter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('bumps optimistically when a reply is sent', async () => {
    const wrapper = mountPost(makePost(5))
    expect(replyCountText(wrapper)).toBe('5')

    await wrapper.get('[data-testid="post-reply-btn"]').trigger('click')
    await wrapper.findComponent({ name: 'Composer' }).vm.$emit('posted', { id: 'reply-1' })
    await wrapper.vm.$nextTick()

    expect(replyCountText(wrapper)).toBe('6')
  })

  it('yields to the server count once the post updates', async () => {
    const post = makePost(5)
    const wrapper = mountPost(post)

    await wrapper.get('[data-testid="post-reply-btn"]').trigger('click')
    await wrapper.findComponent({ name: 'Composer' }).vm.$emit('posted', { id: 'reply-1' })
    await wrapper.vm.$nextTick()
    expect(replyCountText(wrapper)).toBe('6')

    // The store rewrites counts in place from the server row: own reply plus
    // two from other people.
    post.replies_count = 8
    await wrapper.vm.$nextTick()

    expect(replyCountText(wrapper)).toBe('8')
  })

  it('keeps counting from the server base on a second reply', async () => {
    const post = makePost(5)
    const wrapper = mountPost(post)

    await wrapper.get('[data-testid="post-reply-btn"]').trigger('click')
    await wrapper.findComponent({ name: 'Composer' }).vm.$emit('posted', { id: 'reply-1' })
    await wrapper.vm.$nextTick()

    post.replies_count = 8
    await wrapper.vm.$nextTick()

    await wrapper.get('[data-testid="post-reply-btn"]').trigger('click')
    await wrapper.findComponent({ name: 'Composer' }).vm.$emit('posted', { id: 'reply-2' })
    await wrapper.vm.$nextTick()

    expect(replyCountText(wrapper)).toBe('9')
  })

  it('drops the override when the instance is handed a different post', async () => {
    const wrapper = mountPost(makePost(5))

    await wrapper.get('[data-testid="post-reply-btn"]').trigger('click')
    await wrapper.findComponent({ name: 'Composer' }).vm.$emit('posted', { id: 'reply-1' })
    await wrapper.vm.$nextTick()
    expect(replyCountText(wrapper)).toBe('6')

    // Post detail views bind the post unkeyed, so navigation reuses the
    // instance. Same count, different post.
    await wrapper.setProps({ post: makePost(5, 'post-2') })

    expect(replyCountText(wrapper)).toBe('5')
  })
})
