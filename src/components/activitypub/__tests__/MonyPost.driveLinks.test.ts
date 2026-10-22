/**
 * Links to Drive files of this instance, in a post's text or among its link previews, render as
 * Drive attachments (DriveLinkAttachment, by the reader's access) in place of the generic link
 * card. A post that is only a Drive link shows the file without the link text.
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

const post = (embeds: Record<string, unknown>, content: unknown[] = [{ type: 'text', text: 'files' }]) => reactive({
  id: 'post-1',
  author_id: 'local-1',
  author: { id: 'local-1', username: 'ana', display_name: 'Ana', avatar_url: '/default_avatar.webp', domain: null, is_local: true },
  content,
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
  it('renders this instance\'s Drive links as Drive attachments and other links as link cards', () => {
    const wrapper = mountPost(post({
      a: { url: `${here()}/drive/file/${ID}`, title: 'Harmony' },
      b: { url: `${here()}/d/${TOKEN}`, title: 'lighthouse.png' },
      c: { url: 'https://example.com/article', title: 'Article' },
      d: { url: `https://elsewhere.example/drive/file/${ID}`, title: 'Elsewhere' },
    }))

    const cards = wrapper.findAllComponents({ name: 'DriveLinkAttachment' })
    expect(cards.map((c: any) => c.props('link'))).toEqual([
      { kind: 'file', id: ID },
      { kind: 'token', token: TOKEN },
    ])
    expect(wrapper.findAllComponents({ name: 'LinkEmbedCard' }).map((c: any) => c.props('payload').url)).toEqual([
      'https://example.com/article',
      `https://elsewhere.example/drive/file/${ID}`,
    ])
  })

  it('renders a Drive link of the text once, preview or not', () => {
    const url = `${here()}/drive/file/${ID}`
    const wrapper = mountPost(post(
      { a: { url, title: 'Harmony' } },
      [{ type: 'text', text: 'see ' }, { type: 'url', url, preview: true }, { type: 'text', text: ' and ' }, { type: 'url', url: `${here()}/d/${TOKEN}`, preview: true }],
    ))
    expect(wrapper.findAllComponents({ name: 'DriveLinkAttachment' }).map((c: any) => c.props('link'))).toEqual([
      { kind: 'file', id: ID },
      { kind: 'token', token: TOKEN },
    ])
    expect(wrapper.findComponent({ name: 'MonyContent' }).props('content')).toHaveLength(4)
  })

  it('drops the link text of a post that is only a Drive link', () => {
    const url = `${here()}/d/${TOKEN}`
    const wrapper = mountPost(post({}, [{ type: 'url', url, preview: true }]))
    expect(wrapper.findAllComponents({ name: 'DriveLinkAttachment' }).map((c: any) => c.props('url'))).toEqual([url])
    expect(wrapper.findComponent({ name: 'MonyContent' }).props('content')).toEqual([])
  })

  it('keeps the link text of a quoted post that is only a Drive link', () => {
    const url = `${here()}/d/${TOKEN}`
    const quoted = post({}, [{ type: 'url', url, preview: true }])
    const quoting = post({}, [{ type: 'text', text: 'look' }])
    quoting.reblog_of_id = quoted.id
    quoting.reblog = quoted
    quoting.reblog_author = quoted.author
    quoting.metadata = { is_quote: true, embeds: {} }
    const wrapper = mountPost(quoting)
    const contents = wrapper.findAllComponents({ name: 'MonyContent' }).map((c: any) => c.props('content'))
    expect(contents).toContainEqual([{ type: 'url', url, preview: true }])
  })
})
