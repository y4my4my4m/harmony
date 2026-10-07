/**
 * A bridged Discord emoji in the composer's recent list inserts the Discord
 * token, and the inserted text sends as one Discord emoji part.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { ref } from 'vue'

const ID = '1376980620600672316'
const IDENTIFIER = `discord:heh:${ID}`

// Entry as MessageReactions records it from a bridged reaction chip: get_message_reactions
// returns custom_emoji_content as both id and name, and metadata.remote_emoji_url as url.
const recent = ref([{ id: IDENTIFIER, name: IDENTIFIER, url: `https://cdn.discordapp.com/emojis/${ID}.png`, count: 1, lastUsed: 0 }])

vi.mock('@/composables/useFrequentEmojis', () => ({
  useFrequentEmojis: () => ({
    topEmojisForPicker: recent,
    hasFrequentEmojis: ref(true),
    recordEmojiUsage: vi.fn(),
    removeFrequentEmoji: vi.fn(),
    isFrequentEmoji: () => true,
  }),
}))

vi.mock('@/stores/useEmojiCache', () => ({
  PERSONAL_EMOJI_GROUPS: { ai: '__ai_generated__', user: '__user_emoji__', instance: '__instance_emoji__' },
  useEmojiCacheStore: () => ({
    isInitialized: false,
    resolvedEmojis: {},
    globalEmojiIndex: new Map(),
    serverCaches: new Map(),
    nameIndex: new Map(),
    getServerEmojis: () => [],
    getEmojiById: () => null,
    loadPersonalEmojis: vi.fn(),
  }),
}))

vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: null }),
}))

vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentContext: vi.fn().mockResolvedValue({ profileId: null }) },
}))

vi.mock('@/composables/useHapticSettings', () => ({
  useHapticSettings: () => ({ triggerReaction: vi.fn() }),
}))

vi.mock('@/composables/useEmojiLoader', () => ({ triggerEmojiDataLoad: vi.fn() }))

vi.mock('@/services/unifiedEmojiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/unifiedEmojiService')>()),
  useUnifiedEmoji: () => ({
    isNativePack: ref(true),
    isTwemojiPack: ref(false),
    isLoaded: ref(false),
    isLoading: ref(true),
    getAllEmojis: () => [],
    getCategories: () => [],
    searchEmojis: () => [],
    resolveEmoji: () => ({ display: { type: 'native', content: '' }, unicode: '' }),
    getTwemojiUrl: () => '',
  }),
  loadEmojiData: vi.fn(async () => {}),
}))

vi.mock('@/services/EmojiFavoriteService', () => ({
  emojiFavoriteService: {
    initializeCache: vi.fn().mockResolvedValue(undefined),
    getFavorites: vi.fn().mockResolvedValue([]),
    toggleFavorite: vi.fn(),
  },
}))

import EmojiPickerContent from '../EmojiPickerContent.vue'
import { getEmojiShortcodeForInsert } from '@/services/emojiShortcodeResolver'
import { parseContentToMessageParts } from '@/utils/unifiedContentProcessing'
import type { Emoji } from '@/types'

enableAutoUnmount(afterEach)

async function pickRecent(): Promise<Emoji> {
  const wrapper = mount(EmojiPickerContent, {
    global: {
      stubs: { LazyEmojiSection: true, ServerIcon: true, LoadingSpinner: true, Icon: true, EmptyState: true },
      mocks: { $t: (key: string) => key },
    },
  })
  const item = wrapper.get('.frequent-list .emoji-item')
  expect(item.get('img').attributes('src')).toBe(recent.value[0].url)
  await item.trigger('click')
  return wrapper.emitted('sendEmoji')![0][0] as Emoji
}

describe('recent Discord emoji in the composer', () => {
  afterEach(() => {
    recent.value[0].url = `https://cdn.discordapp.com/emojis/${ID}.png`
  })

  it('inserts the Discord token and sends one emoji part', async () => {
    const inserted = getEmojiShortcodeForInsert(await pickRecent())
    expect(inserted).toBe(`:discord:heh:${ID}:`)

    const parts = await parseContentToMessageParts(`...factors ${inserted} )`)
    expect(parts).toEqual([
      { type: 'text', text: '...factors ' },
      {
        type: 'emoji',
        emoji: {
          name: 'heh',
          url: `https://cdn.discordapp.com/emojis/${ID}.png`,
          id: null,
          domain: 'discord.com',
          display_name: 'heh',
          server_id: null,
        },
      },
      { type: 'text', text: ' )' },
    ])
  })

  it('keeps an animated emoji animated', async () => {
    recent.value[0].url = `https://cdn.discordapp.com/emojis/${ID}.gif`
    const inserted = getEmojiShortcodeForInsert(await pickRecent())
    expect(inserted).toBe(`:discord:a:heh:${ID}:`)

    const [part] = await parseContentToMessageParts(inserted)
    expect(part).toMatchObject({ type: 'emoji', emoji: { name: 'heh', url: `https://cdn.discordapp.com/emojis/${ID}.gif` } })
  })
})

describe('getEmojiShortcodeForInsert', () => {
  it('leaves Harmony custom and unicode emoji as before', () => {
    const blobcat = { id: '6f1c2a34-1111-4222-8333-444455556666', name: 'blobcat', url: 'https://harmony.test/e.png' } as Emoji
    expect(getEmojiShortcodeForInsert(blobcat)).toBe(':blobcat:')
    expect(getEmojiShortcodeForInsert({ ...blobcat, display_name: 'blobcat~1' } as Emoji)).toBe(':blobcat~1:')
    expect(getEmojiShortcodeForInsert({ id: '🎉', name: 'tada', url: '' } as Emoji)).toBe('🎉')
  })
})
