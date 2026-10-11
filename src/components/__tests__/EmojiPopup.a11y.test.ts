/**
 * The reaction picker is a modal dialog: named, focus in its labelled search,
 * Escape closing it; emoji are buttons named in words; Enter in the search picks
 * the first result; category headers are disclosure buttons. The grid's tab
 * stop and arrow keys run in the journey (a11y-messages.spec.ts).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, ref } from 'vue'

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

let wrapper: VueWrapper | null = null

async function mountPopup(props: Record<string, unknown> = {}) {
  wrapper = mount(EmojiPopup, {
    props,
    global: {
      stubs: { teleport: true, LazyEmojiSection: true, ServerIcon: true, LoadingSpinner: true, Icon: true, EmptyState: true },
      mocks: { $t: (key: string) => key },
    },
    attachTo: document.body,
  })
  await flushPromises()
  await nextTick()
  return wrapper
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('EmojiPopup as a dialog', () => {
  it('is a named modal dialog with focus in its labelled search', async () => {
    const w = await mountPopup({ isReaction: true })
    const dialog = w.get('.emoji-popup')
    expect(dialog.attributes('role')).toBe('dialog')
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(dialog.attributes('aria-label')).toBe('messageA11y.emoji.reactionDialog')
    const search = w.get('input.search-input')
    expect(search.attributes('aria-label')).toBe('messageA11y.emoji.search')
    expect(document.activeElement).toBe(search.element)
  })

  it('names emoji in words', async () => {
    const w = await mountPopup()
    const items = w.findAll('.frequent-list .emoji-item')
    expect(items.map((i) => i.attributes('aria-label'))).toEqual(['tada', 'grinning'])
    expect(items.every((i) => i.element.tagName === 'BUTTON')).toBe(true)
  })

  it('picks the first result on Enter in the search', async () => {
    const w = await mountPopup()
    await w.get('input.search-input').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('sendEmoji')?.[0]?.[0]).toMatchObject({ id: '🎉' })
  })

  it('closes on Escape', async () => {
    const closeEmojiList = vi.fn()
    const w = await mountPopup({ closeEmojiList })
    w.get('input.search-input').element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(closeEmojiList).toHaveBeenCalled()
  })

  it('exposes category headers as disclosure buttons', async () => {
    const w = await mountPopup()
    const header = () => w.findAll('.section-title button').find((b) => b.text().includes('Frequently used'))!
    expect(header().attributes('aria-expanded')).toBe('true')
    await header().trigger('click')
    expect(header().attributes('aria-expanded')).toBe('false')
    expect(w.find('.frequent-list').exists()).toBe(false)
  })
})
