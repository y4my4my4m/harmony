/**
 * The heart reaction is the favourite in `MonyPost.vue`: picking \u2764 from the reaction
 * picker toggles the heart action instead of adding a chip, any other reaction fills the
 * heart through an implied favourite, unfavouriting drops the caller's reactions, and the
 * focused post lists its reactions under the content, above the meta and the Mastodon-style
 * counts line.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, reactive, ref, computed } from 'vue'

const { toggleFavorite, getFavouriteState, keepFavourite } = vi.hoisted(() => ({
  toggleFavorite: vi.fn(),
  getFavouriteState: vi.fn(),
  keepFavourite: vi.fn(),
}))

// A plural count is appended so a label can be told apart by it.
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, arg?: unknown) => (key === 'activitypub.unfavoriteWithReactions' ? `${key}(${arg})` : key),
  }),
  createI18n: () => ({ install: () => {}, global: { t: (key: string) => key } }),
}))

vi.mock('@/services', () => ({
  services: { posts: { getFavouriteState, keepFavourite } },
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

import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { supabase } from '@/supabase'
import { usePostReactionsStore } from '@/stores/postReactions'
import MonyPost from '../MonyPost.vue'
import PostReactions from '../PostReactions.vue'

let pinia: Pinia

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
      plugins: [pinia],
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

const settle = async (wrapper: any) => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
}

const heart = (wrapper: any) => wrapper.get('[data-testid="post-favorite-btn"]')

const chip = (content: string, mine: boolean, count = 1) => ({
  emoji_id: null, emoji_name: null, emoji_url: null, custom_emoji_content: content,
  reaction_count: count, user_reactions: [], current_user_reacted: mine,
})

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

describe('MonyPost heart reaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toggleFavorite.mockResolvedValue({ success: true, liked: true, newCount: 1 })
    getFavouriteState.mockResolvedValue({ favorited: true, count: 1 })
    rpc.mockResolvedValue({ data: null, error: null })
  })

  it('picking \u2764\uFE0F toggles the favourite instead of adding a reaction', async () => {
    const wrapper = mountPost(makePost())

    await pick(wrapper, '\u2764\uFE0F', 'red_heart')

    expect(toggleFavorite).toHaveBeenCalledWith('post-1')
    expect(rpc).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="post-favorite-btn"]').attributes('aria-pressed')).toBe('true')
  })

  it('picking any other emoji is a reaction, which fills the heart without favouriting', async () => {
    const wrapper = mountPost(makePost())

    await pick(wrapper, '🎉', 'tada')
    await settle(wrapper)

    expect(toggleFavorite).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('add_post_emoji_reaction', expect.objectContaining({
      p_custom_emoji_content: '🎉',
    }))
    expect(getFavouriteState).toHaveBeenCalledWith('post-1')
    expect(heart(wrapper).attributes('aria-pressed')).toBe('true')
  })
})

describe('MonyPost heart and reactions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rpc.mockResolvedValue({ data: [], error: null })
  })

  it('fills and counts the heart at once when a reaction is added', async () => {
    let resolveState: (v: unknown) => void = () => {}
    getFavouriteState.mockReturnValue(new Promise((resolve) => { resolveState = resolve }))
    const wrapper = mountPost(makePost({ favorites_count: 4 }))

    wrapper.findComponent(PostReactions).vm.$emit('reactions-changed', { added: true })
    await wrapper.vm.$nextTick()

    expect(heart(wrapper).attributes('aria-pressed')).toBe('true')
    expect(heart(wrapper).text()).toBe('5')

    resolveState({ favorited: true, count: 5 })
    await settle(wrapper)
    expect(heart(wrapper).text()).toBe('5')
  })

  it('empties the heart when the last reaction took an implied favourite with it', async () => {
    getFavouriteState.mockResolvedValue({ favorited: false, count: 0 })
    const post = makePost({ favorites_count: 1 })
    post.is_favorited = true
    const wrapper = mountPost(post)

    wrapper.findComponent(PostReactions).vm.$emit('reactions-changed', { added: false })
    await settle(wrapper)

    expect(heart(wrapper).attributes('aria-pressed')).toBe('false')
    expect(heart(wrapper).find('.action-count').exists()).toBe(false)
  })

  it('keeps an explicit heart filled after the last reaction goes', async () => {
    getFavouriteState.mockResolvedValue({ favorited: true, count: 1 })
    const post = makePost({ favorites_count: 1 })
    post.is_favorited = true
    const wrapper = mountPost(post)

    wrapper.findComponent(PostReactions).vm.$emit('reactions-changed', { added: false })
    await settle(wrapper)

    expect(heart(wrapper).attributes('aria-pressed')).toBe('true')
  })

  it('says in the heart\'s tooltip that unfavouriting removes the caller\'s reactions', async () => {
    const post = makePost({ favorites_count: 2 })
    post.is_favorited = true
    usePostReactionsStore().bulkSetReactions({
      'post-1': [chip('🎉', true, 2), chip('👀', true), chip('🚀', false)] as any,
    })
    const wrapper = mountPost(post)

    expect(heart(wrapper).attributes('title')).toBe('activitypub.unfavoriteWithReactions(2)')
    expect(heart(wrapper).attributes('aria-label')).toBe('activitypub.unfavoriteWithReactions(2)')

    usePostReactionsStore().bulkSetReactions({ 'post-1': [chip('🚀', false)] as any })
    await wrapper.vm.$nextTick()
    expect(heart(wrapper).attributes('title')).toBe('activitypub.unfavorite')

    post.is_favorited = false
    await wrapper.vm.$nextTick()
    expect(heart(wrapper).attributes('title')).toBe('activitypub.favorite')
  })

  it('unfavouriting drops the caller\'s reaction chips at once and refetches them', async () => {
    let resolveToggle: (v: unknown) => void = () => {}
    toggleFavorite.mockReturnValue(new Promise((resolve) => { resolveToggle = resolve }))
    const remaining = [chip('🎉', false, 1)]
    rpc.mockImplementation(async (fn: string) =>
      ({ data: fn === 'get_post_emoji_reactions' ? remaining : null, error: null }))
    const post = makePost({ favorites_count: 2 })
    post.is_favorited = true
    const store = usePostReactionsStore()
    store.bulkSetReactions({ 'post-1': [chip('🎉', true, 2), chip('👀', true)] as any })
    const wrapper = mountPost(post)

    await heart(wrapper).trigger('click')

    expect(store.getPostReactions('post-1')).toEqual([expect.objectContaining({
      custom_emoji_content: '🎉', reaction_count: 1, current_user_reacted: false,
    })])
    expect(rpc).not.toHaveBeenCalledWith('get_post_emoji_reactions', expect.anything())

    resolveToggle({ success: true, liked: false, newCount: 1 })
    await settle(wrapper)
    expect(toggleFavorite).toHaveBeenCalledWith('post-1')
    expect(rpc).toHaveBeenCalledWith('get_post_emoji_reactions', expect.objectContaining({ p_post_id: 'post-1' }))
    expect(store.getPostReactions('post-1')).toEqual(remaining)
    expect(heart(wrapper).attributes('aria-pressed')).toBe('false')
  })

  it('picking ❤ on a heart only reactions filled makes the favourite explicit, not unfavourited', async () => {
    getFavouriteState.mockResolvedValue({ favorited: true, implied: true, count: 3 })
    keepFavourite.mockResolvedValue(undefined)
    const post = makePost({ favorites_count: 3 })
    post.is_favorited = true
    const wrapper = mountPost(post)

    await pick(wrapper, '\u2764\uFE0F', 'red_heart')
    await settle(wrapper)

    expect(keepFavourite).toHaveBeenCalledWith('post-1')
    expect(toggleFavorite).not.toHaveBeenCalled()
    expect(heart(wrapper).attributes('aria-pressed')).toBe('true')
    expect(heart(wrapper).text()).toBe('3')
  })

  it('picking ❤ on a heart clicked explicitly unfavourites', async () => {
    getFavouriteState.mockResolvedValue({ favorited: true, implied: false, count: 3 })
    toggleFavorite.mockResolvedValue({ success: true, liked: false, newCount: 2 })
    const post = makePost({ favorites_count: 3 })
    post.is_favorited = true
    const wrapper = mountPost(post)

    await pick(wrapper, '\u2764\uFE0F', 'red_heart')
    await settle(wrapper)

    expect(keepFavourite).not.toHaveBeenCalled()
    expect(toggleFavorite).toHaveBeenCalledWith('post-1')
    expect(heart(wrapper).attributes('aria-pressed')).toBe('false')
  })

  it('gives the picker the per-person limit: held emoji and the heart pass, new ones are refused', async () => {
    const mine = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊']
    usePostReactionsStore().bulkSetReactions({ 'post-1': mine.map((e) => chip(e, true)) as any })
    const wrapper = mountPost(makePost())

    await wrapper.get('.add-reaction-button').trigger('click')
    const popup = wrapper.findComponent({ name: 'EmojiPopup' })

    expect(popup.props('limitNotice')).toBe('emoji.postReactionLimit')
    const blocked = popup.props('isEmojiBlocked') as (e: { id: string }) => boolean
    expect(blocked({ id: '🎉' })).toBe(true)
    expect(blocked({ id: '😀' })).toBe(false)
    expect(blocked({ id: '❤️' })).toBe(false)
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
