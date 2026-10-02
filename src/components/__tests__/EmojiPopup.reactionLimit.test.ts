/**
 * The reaction picker under a reaction limit: refused emoji are dimmed and send nothing,
 * held ones still send, and the limit is stated above the list.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { ref } from 'vue'

vi.mock('@/stores/useEmojiCache', () => ({
  useEmojiCacheStore: () => ({
    resolvedEmojis: {},
    globalEmojiIndex: new Map(),
    serverCaches: new Map(),
    getServerEmojis: () => [],
    getEmojiById: () => null,
  }),
}))

vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: null }),
}))

const recordEmojiUsage = vi.fn()
vi.mock('@/composables/useFrequentEmojis', () => ({
  useFrequentEmojis: () => ({
    topEmojisForPicker: ref([
      { id: '🎉', native: '🎉', name: 'tada', count: 3, lastUsed: 0 },
      { id: '😀', native: '😀', name: 'grinning', count: 2, lastUsed: 0 },
    ]),
    hasFrequentEmojis: ref(true),
    recordEmojiUsage,
    removeFrequentEmoji: vi.fn(),
    isFrequentEmoji: () => true,
  }),
}))

vi.mock('@/composables/useHapticSettings', () => ({
  useHapticSettings: () => ({ triggerReaction: vi.fn() }),
}))

vi.mock('@/composables/useEmojiLoader', () => ({ triggerEmojiDataLoad: vi.fn() }))

vi.mock('@/composables/usePopupPositioning', () => ({
  usePopupPositioning: () => ({ positionStyle: ref({}), updatePosition: vi.fn() }),
}))

vi.mock('@/services/unifiedEmojiService', () => ({
  useUnifiedEmoji: () => ({
    isNativePack: ref(true),
    isTwemojiPack: ref(false),
    currentPack: ref('native'),
    isLoaded: ref(false),
    isLoading: ref(true),
    getAllEmojis: () => [],
    getCategories: () => [],
    searchEmojis: () => [],
    resolveEmoji: () => ({ display: { type: 'native', content: '' }, unicode: '' }),
    getTwemojiUrl: () => '',
    reload: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('@/services/EmojiFavoriteService', () => ({
  emojiFavoriteService: {
    initializeCache: vi.fn().mockResolvedValue(undefined),
    getFavorites: vi.fn().mockResolvedValue([]),
    toggleFavorite: vi.fn(),
  },
}))

import EmojiPopup from '../EmojiPopup.vue'
enableAutoUnmount(afterEach)

const mountPopup = (props: Record<string, unknown>) =>
  mount(EmojiPopup, {
    props,
    global: {
      stubs: { teleport: true, LazyEmojiSection: true, ServerIcon: true, LoadingSpinner: true, Icon: true, EmptyState: true },
      mocks: { $t: (key: string) => key },
    },
  })

const frequentItem = (wrapper: any, glyph: string) =>
  wrapper.findAll('.frequent-list .emoji-item').find((item: any) => item.text() === glyph)!

describe('EmojiPopup reaction limit', () => {
  beforeEach(() => {
    recordEmojiUsage.mockClear()
  })

  it('sends every emoji when no limit applies', async () => {
    const wrapper = mountPopup({})

    expect(wrapper.find('[data-testid="emoji-limit-notice"]').exists()).toBe(false)
    expect(wrapper.findAll('.emoji-item--blocked')).toHaveLength(0)

    await frequentItem(wrapper, '🎉').trigger('click')
    expect(wrapper.emitted('sendEmoji')?.[0]?.[0]).toMatchObject({ id: '🎉' })
  })

  it('dims a refused emoji, sends nothing for it, and states the limit', async () => {
    const isEmojiBlocked = (emoji: { id?: string }) => emoji.id === '🎉'
    const wrapper = mountPopup({ isEmojiBlocked, limitNotice: 'This message has 20 different reactions.' })

    expect(wrapper.get('[data-testid="emoji-limit-notice"]').text()).toBe('This message has 20 different reactions.')
    const refused = frequentItem(wrapper, '🎉')
    expect(refused.classes()).toContain('emoji-item--blocked')
    expect(refused.attributes('aria-disabled')).toBe('true')

    await refused.trigger('click')
    expect(wrapper.emitted('sendEmoji')).toBeUndefined()
    expect(recordEmojiUsage).not.toHaveBeenCalled()
    expect(wrapper.find('.fav-toast').text()).toBe('This message has 20 different reactions.')
  })

  it('still sends an emoji the limit allows', async () => {
    const wrapper = mountPopup({ isEmojiBlocked: (emoji: { id?: string }) => emoji.id === '🎉', limitNotice: 'limit' })

    const allowed = frequentItem(wrapper, '😀')
    expect(allowed.classes()).not.toContain('emoji-item--blocked')
    await allowed.trigger('click')

    expect(wrapper.emitted('sendEmoji')?.[0]?.[0]).toMatchObject({ id: '😀' })
  })
})
