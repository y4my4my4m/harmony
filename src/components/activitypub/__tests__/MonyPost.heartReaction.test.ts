/**
 * The heart reaction is the favourite in `MonyPost.vue`: picking \u2764 from the reaction
 * picker toggles the heart action instead of adding a chip, and the focused post lists
 * its reactions under the content, above the meta and the Mastodon-style counts line.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, reactive, ref, computed } from 'vue'

const { toggleFavorite } = vi.hoisted(() => ({ toggleFavorite: vi.fn() }))

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
    toggleFavorite,
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

import { supabase } from '@/supabase'
import MonyPost from '../MonyPost.vue'

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

const makePost = (counts: Partial<Record<'favorites_count' | 'reblogs_count' | 'replies_count', number>> = {}) => reactive({
  id: 'post-1',
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
  replies_count: 0,
  is_favorited: false,
  is_reblogged: false,
  is_bookmarked: false,
  ...counts,
}) as any

const mountPost = (post: any, detailed = false) =>
  mount(MonyPost, {
    props: { post, detailed },
    shallow: true,
    global: {
      directives: { 'click-outside': {} },
      stubs: { teleport: true },
    },
  })

// The picker sends a unicode emoji as `id`, with an empty url.
const pick = async (wrapper: any, unicode: string, name: string) => {
  await wrapper.get('.add-reaction-button').trigger('click')
  wrapper.findComponent({ name: 'EmojiPopup' }).vm.$emit('sendEmoji', { id: unicode, name, url: '' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
}

describe('MonyPost heart reaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toggleFavorite.mockResolvedValue({ success: true, liked: true, newCount: 1 })
    rpc.mockResolvedValue({ data: null, error: null })
  })

  it('picking \u2764\uFE0F toggles the favourite instead of adding a reaction', async () => {
    const wrapper = mountPost(makePost())

    await pick(wrapper, '\u2764\uFE0F', 'red_heart')

    expect(toggleFavorite).toHaveBeenCalledWith('post-1')
    expect(rpc).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="post-favorite-btn"]').attributes('aria-pressed')).toBe('true')
  })

  it('picking any other emoji is a reaction and leaves the heart alone', async () => {
    const wrapper = mountPost(makePost())

    await pick(wrapper, '🎉', 'tada')

    expect(toggleFavorite).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('add_post_emoji_reaction', expect.objectContaining({
      p_custom_emoji_content: '🎉',
    }))
  })
})

describe('MonyPost focused post', () => {
  it('lists reactions under the content, above the meta and the counts', () => {
    const wrapper = mountPost(makePost({ favorites_count: 2, reblogs_count: 1 }), true)
    const html = wrapper.html()

    const reactions = html.indexOf('post-reactions-stub')
    expect(reactions).toBeGreaterThan(html.indexOf('class="post-body"'))
    expect(reactions).toBeLessThan(html.indexOf('class="detail-meta"'))
    expect(html.indexOf('class="detail-stats"')).toBeLessThan(html.indexOf('class="post-actions"'))
  })

  it('writes the counts in Mastodon\'s order, middot-separated, without zeroes', () => {
    const wrapper = mountPost(makePost({ favorites_count: 2, reblogs_count: 1 }), true)

    expect(wrapper.findAll('.detail-stat').map((s) => s.text().replace(/\s+/g, ' '))).toEqual([
      '1 activitypub.boostsLabel',
      '2 activitypub.favoritesLabel',
    ])
    expect(wrapper.findAll('.detail-stats-separator').map((s) => s.text())).toEqual(['·'])
  })
})
