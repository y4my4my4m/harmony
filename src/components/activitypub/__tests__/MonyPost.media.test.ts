/**
 * Media of remote posts in `MonyPost.vue`. Sensitive media is blurred only inside
 * MonyMediaGallery, so every image of a post reaches the gallery: media_attachments, or
 * the content file parts of remote posts stored without them, a reblog's snapshot, and a
 * quote's own media beside its comment.
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

const AUTHOR = {
  id: 'remote-1',
  username: 'ana',
  display_name: 'Ana',
  avatar_url: '/default_avatar.webp',
  domain: 'remote.test',
  is_local: false,
}

const imagePart = {
  type: 'file', url: 'https://files.remote.test/a.png', fileType: 'image', mimeType: 'image/png', altText: 'a red square',
}
const storedImage = {
  type: 'Document', mediaType: 'image/png', url: 'https://files.remote.test/a.png', description: 'a red square',
}

const makePost = (extra: Record<string, unknown>) => reactive({
  id: 'post-1',
  author_id: AUTHOR.id,
  author: AUTHOR,
  content: [{ type: 'text', text: 'hello' }],
  created_at: '2026-01-01T00:00:00Z',
  visibility: 'public',
  is_local: false,
  favorites_count: 0,
  reblogs_count: 0,
  replies_count: 0,
  media_attachments: [],
  ...extra,
}) as any

const mountPost = (post: any) =>
  mount(MonyPost, {
    props: { post },
    shallow: true,
    global: {
      plugins: [createPinia()],
      directives: { 'click-outside': {} },
    },
  })

const galleries = (wrapper: any) =>
  wrapper.findAllComponents({ name: 'MonyMediaGallery' }).map((g: any) => ({
    urls: g.props('mediaAttachments').map((m: any) => m.url),
    types: g.props('mediaAttachments').map((m: any) => m.type),
    isSensitive: g.props('isSensitive'),
  }))

const contents = (wrapper: any) =>
  wrapper.findAllComponents({ name: 'MonyContent' }).map((c: any) => c.props('content'))

describe('MonyPost media', () => {
  it('blurs sensitive media a remote post holds only as content file parts', () => {
    const wrapper = mountPost(makePost({
      is_sensitive: true,
      content: [{ type: 'text', text: 'look' }, imagePart],
    }))

    expect(galleries(wrapper)).toEqual([
      { urls: [imagePart.url], types: ['image'], isSensitive: true },
    ])
    expect(contents(wrapper)).toContainEqual([{ type: 'text', text: 'look' }])
  })

  it('shows media_attachments of a remote post once, in the gallery', () => {
    const wrapper = mountPost(makePost({
      is_sensitive: true,
      content: [imagePart],
      media_attachments: [storedImage],
    }))

    expect(galleries(wrapper)).toEqual([
      { urls: [storedImage.url], types: ['image'], isSensitive: true },
    ])
    expect(contents(wrapper)).toContainEqual([])
  })

  it('blurs the sensitive media of a boosted post', () => {
    const wrapper = mountPost(makePost({
      ap_type: 'Announce',
      content: [],
      metadata: { reblog_of: 'orig-1' },
      reblog: { id: 'orig-1', content: [imagePart], is_sensitive: true, media_attachments: [storedImage] },
      reblog_author: AUTHOR,
    }))

    expect(galleries(wrapper)).toEqual([
      { urls: [storedImage.url], types: ['image'], isSensitive: true },
    ])
  })

  it('shows a quote\'s own media beside its comment, with the quote\'s sensitivity', () => {
    const own = { ...storedImage, url: 'https://files.remote.test/own.png' }
    const wrapper = mountPost(makePost({
      is_sensitive: true,
      content: [{ type: 'text', text: 'my take' }, { ...imagePart, url: own.url }],
      media_attachments: [own],
      metadata: { reblog_of: 'orig-1', is_quote: true },
      reblog: { id: 'orig-1', content: [{ type: 'text', text: 'original' }, imagePart], is_sensitive: false, media_attachments: [] },
      reblog_author: AUTHOR,
    }))

    expect(galleries(wrapper)).toEqual([
      { urls: [own.url], types: ['image'], isSensitive: true },
      { urls: [imagePart.url], types: ['image'], isSensitive: true },
    ])
    expect(contents(wrapper)).toEqual([
      [{ type: 'text', text: 'my take' }],
      [{ type: 'text', text: 'original' }],
    ])
  })
})
