/**
 * Links to Drive files of this instance among a post's link previews render the Drive card
 * (DriveLinkCard, by the reader's access) in place of the generic link card.
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

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b'
const TOKEN = 'h5KAj-hPSm5hwCpMfeKM8aZl'
const here = () => `${window.location.protocol}//${window.location.host}`

const post = (embeds: Record<string, unknown>) => reactive({
  id: 'post-1',
  author_id: 'local-1',
  author: { id: 'local-1', username: 'ana', display_name: 'Ana', avatar_url: '/default_avatar.webp', domain: null, is_local: true },
  content: [{ type: 'text', text: 'files' }],
  created_at: '2026-01-01T00:00:00Z',
  visibility: 'public',
  is_local: true,
  favorites_count: 0,
  reblogs_count: 0,
  replies_count: 0,
  media_attachments: [],
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

describe('MonyPost Drive links', () => {
  it('renders this instance\'s Drive links as Drive cards and other links as link cards', () => {
    const wrapper = mountPost(post({
      a: { url: `${here()}/drive/file/${ID}`, title: 'Harmony' },
      b: { url: `${here()}/d/${TOKEN}`, title: 'lighthouse.png' },
      c: { url: 'https://example.com/article', title: 'Article' },
      d: { url: `https://elsewhere.example/drive/file/${ID}`, title: 'Elsewhere' },
    }))

    const cards = wrapper.findAllComponents({ name: 'DriveLinkCard' })
    expect(cards.map((c: any) => c.props('link'))).toEqual([
      { kind: 'file', id: ID },
      { kind: 'token', token: TOKEN },
    ])
    expect(wrapper.findAllComponents({ name: 'LinkEmbedCard' }).map((c: any) => c.props('payload').url)).toEqual([
      'https://example.com/article',
      `https://elsewhere.example/drive/file/${ID}`,
    ])
  })
})
