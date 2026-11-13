/**
 * A query that with its colon is an emoticon (`:P`, `:D`) lists the emoticon's emoji first,
 * ahead of custom emoji whose names start with the same letter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick } from 'vue'
import type { Ref } from 'vue'

// Module mocks must be declared before the SUT import.

const emojiCache = vi.hoisted(() => ({
  resolvedEmojis: {} as Record<string, unknown>,
  loadPersonalEmojis: vi.fn(async (_profileId: string | null) => {}),
}))

vi.mock('@/stores/useEmojiCache', () => ({
  useEmojiCacheStore: () => ({
    get resolvedEmojis() { return emojiCache.resolvedEmojis },
    isInitialized: true,
    serverCaches: new Map(),
    loadPersonalEmojis: (profileId: string | null) => emojiCache.loadPersonalEmojis(profileId),
  }),
}))

const authContext = vi.hoisted(() => ({ getCurrentContext: vi.fn(async () => ({ profileId: 'p1' as string | null })) }))
vi.mock('@/services/AuthContextService', () => ({ authContextService: authContext }))

vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({
    currentServerId: null,
    currentChannelId: null,
    servers: [],
  }),
}))

vi.mock('@/services/userDataService', () => ({
  userDataService: {
    getUsersInContext: () => [],
    getAllUsers: () => [],
  },
}))

vi.mock('@/services/activityPubService', () => ({
  activityPubService: {
    searchUsers: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('@/services/RoleService', () => ({
  roleService: {
    getServerRoles: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('@/composables/useChannelMessagePermissions', () => ({
  useChannelMessagePermissions: () => ({ canMentionEveryone: { value: false } }),
}))

vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({
    hasCurrentUserPermission: () => true,
    Permission: {},
    isCurrentUserServerOwner: () => false,
  }),
}))

vi.mock('@/composables/useEmojiLoader', () => ({
  ensureEmojiDataLoaded: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    }),
  },
}))

const isLoaded = ref(true)
const isNativePack = ref(true)
const prefs = vi.hoisted(() => ({ convertSent: true, renderReceived: true }))

vi.mock('@/composables/useVisualTheme', () => ({ emoticonPreferences: () => prefs }))

vi.mock('@/services/unifiedEmojiService', async () => {
  const { buildUnicodeIndex, searchUnicodeIndex } = await vi.importActual<typeof import('@/services/emojiSearchIndex')>('@/services/emojiSearchIndex')
  const fixtures = [
    { unicode: '😛', shortcode: 'face_with_tongue', name: 'face with tongue', category: 'people', codepoint: '1f61b', keywords: ['tongue'] },
    { unicode: '😄', shortcode: 'grinning_face_with_smiling_eyes', name: 'grinning face with smiling eyes', category: 'people', codepoint: '1f604', keywords: ['smile'] },
    { unicode: '🅿️', shortcode: 'p_button', name: 'P button', category: 'symbols', codepoint: '1f17f', keywords: ['parking'] },
  ]
  const shortcodes: Record<string, string> = {
    face_with_tongue: '😛', stuck_out_tongue: '😛',
    grinning_face_with_smiling_eyes: '😄', smile: '😄',
    p_button: '🅿️', parking: '🅿️',
  }
  const index = buildUnicodeIndex(fixtures, shortcodes)
  return {
    useUnifiedEmoji: () => ({
      isLoaded,
      isNativePack,
      getTwemojiUrl: () => null,
      unicodeToShortcode: (unicode: string) => fixtures.find((e) => e.unicode === unicode)?.shortcode ?? null,
      searchEmojiHits: (query: string, limit = 50) => searchUnicodeIndex(index, query, limit),
    }),
  }
})

import { useAutoSuggest } from '../useAutoSuggest'

const custom = (...names: string[]) => ({
  s1: {
    server_name: 'Lounge',
    emojis: names.map((name, i) => ({
      id: `c0ffee00-0000-4000-8000-00000000000${i}`, name, display_name: name, url: `https://cdn.test/${name}.png`,
    })),
  },
})

describe('useAutoSuggest - emoticon queries', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    isLoaded.value = true
    prefs.convertSent = true
    emojiCache.resolvedEmojis = {}
    emojiCache.loadPersonalEmojis.mockReset().mockResolvedValue(undefined)
    authContext.getCurrentContext.mockReset().mockResolvedValue({ profileId: 'p1' })
  })

  const suggestionsFor = async (typed: string) => {
    const text = ref(typed)
    const auto = useAutoSuggest(ref<HTMLTextAreaElement | null>(null) as Ref<any>, () => text.value, () => {}, { mode: 'chat' })
    auto.handleInput(typed, typed.length)
    await nextTick()
    return auto.suggestions.value.map((s) => ({ name: s.name, native: s.native }))
  }

  it('lists the tongue emoji first for `:P`, ahead of a custom emoji named PP', async () => {
    emojiCache.resolvedEmojis = custom('PP', 'party')
    const list = await suggestionsFor(':P')
    expect(list[0]).toEqual({ name: 'stuck_out_tongue', native: '😛' })
    expect(list.slice(1).map((s) => s.name)).toEqual(['PP', 'party'])
  })

  it('does the same for the lowercase `:p` and for `:D`', async () => {
    emojiCache.resolvedEmojis = custom('PP', 'dance')
    expect((await suggestionsFor(':p'))[0]).toEqual({ name: 'stuck_out_tongue', native: '😛' })
    expect((await suggestionsFor(':D'))[0]).toEqual({ name: 'smile', native: '😄' })
  })

  it('lists nothing for `:P` when no other emoji matches, leaving Enter to the message', async () => {
    expect(await suggestionsFor(':P')).toEqual([])
  })

  it('ranks by name again once the query is no emoticon', async () => {
    emojiCache.resolvedEmojis = custom('PP', 'party')
    const list = await suggestionsFor(':PP')
    expect(list[0].name).toBe('PP')
    expect(list.map((s) => s.native)).not.toContain('😛')
  })

  it('leaves the order alone with emoticon conversion off', async () => {
    prefs.convertSent = false
    emojiCache.resolvedEmojis = custom('PP')
    expect((await suggestionsFor(':P')).map((s) => s.name)).toEqual(['PP'])
  })
})
