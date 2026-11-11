/**
 * Regression test: typing `:+1` should suggest the thumbs-up emoji.
 *
 * The bug report:
 *   "in chat when i type :+1 its not suggesting the thumbsup... despite that
 *    working in the emoji search"
 *
 * The keyword `+1` is in the emoji data file under `thumbs_up.keywords`. The
 * picker (`EmojiPickerContent.vue`) finds it via its own filter. The
 * autosuggest uses `searchEmojis` from `unifiedEmojiService`, which has the
 * same keyword check. So why doesn't it show up?
 *
 * This test wires up `useAutoSuggest` with realistic stubs and asserts that
 * after typing `:+1`, the suggestions contain `thumbs_up`. If it fails, we
 * have a concrete repro.
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

// Real-ish unified emoji service. `isLoaded` defaults to `true` so the
// autosuggest's `unifiedLoaded.value` gate passes; the keyword search is the
// real one from the production code.
const isLoaded = ref(true)
const isNativePack = ref(true)

vi.mock('@/services/unifiedEmojiService', async () => {
  const { buildUnicodeIndex, searchUnicodeIndex } = await vi.importActual<typeof import('@/services/emojiSearchIndex')>('@/services/emojiSearchIndex')
  const fixtures = [
    {
      unicode: '👍',
      shortcode: 'thumbs_up',
      name: 'thumbs up',
      category: 'people',
      codepoint: '1f44d',
      keywords: ['thumbs_up', 'thumbsup', '+1', 'thumbs', 'up'],
    },
    {
      unicode: '👎',
      shortcode: 'thumbs_down',
      name: 'thumbs down',
      category: 'people',
      codepoint: '1f44e',
      keywords: ['thumbs_down', 'thumbsdown', '-1', 'thumbs', 'down'],
    },
    {
      unicode: '😀',
      shortcode: 'grinning_face',
      name: 'grinning face',
      category: 'people',
      codepoint: '1f600',
      keywords: ['grinning', 'face', 'smile', 'happy'],
    },
  ]
  const index = buildUnicodeIndex(fixtures, Object.fromEntries(fixtures.map((e) => [e.shortcode, e.unicode])))
  return {
    useUnifiedEmoji: () => ({
      isLoaded,
      isNativePack,
      getTwemojiUrl: () => null,
      searchEmojiHits: (query: string, limit = 50) => searchUnicodeIndex(index, query, limit),
    }),
  }
})

import { useAutoSuggest } from '../useAutoSuggest'

describe('useAutoSuggest - emoji trigger for `:+1`', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    isLoaded.value = true
    emojiCache.resolvedEmojis = {}
    emojiCache.loadPersonalEmojis.mockReset().mockResolvedValue(undefined)
    authContext.getCurrentContext.mockReset().mockResolvedValue({ profileId: 'p1' })
  })

  const setup = () => {
    const text = ref('')
    const cursor = ref(0)
    const inputElement = ref<HTMLTextAreaElement | null>(null)
    const getCurrentText = () => text.value
    const updateText = (newText: string, newCursor?: number) => {
      text.value = newText
      if (newCursor !== undefined) cursor.value = newCursor
    }
    const auto = useAutoSuggest(
      inputElement as Ref<any>,
      getCurrentText,
      updateText,
      { mode: 'chat' },
    )
    return { auto, text, cursor }
  }

  it('activates the emoji trigger when the user types `:`', () => {
    const { auto } = setup()
    auto.handleInput(':', 1)
    expect(auto.state.value.isActive).toBe(true)
    expect(auto.state.value.triggerType).toBe('emoji')
    expect(auto.state.value.query).toBe('')
  })

  it('keeps the emoji trigger active and updates the query as the user types `:+`', () => {
    const { auto } = setup()
    auto.handleInput(':+', 2)
    expect(auto.state.value.isActive).toBe(true)
    expect(auto.state.value.triggerType).toBe('emoji')
    expect(auto.state.value.query).toBe('+')
  })

  it('captures `+1` as the query for `:+1`', () => {
    const { auto } = setup()
    auto.handleInput(':+1', 3)
    expect(auto.state.value.isActive).toBe(true)
    expect(auto.state.value.triggerType).toBe('emoji')
    expect(auto.state.value.query).toBe('+1')
  })

  it('surfaces thumbs_up in suggestions for `:+1`', async () => {
    const { auto } = setup()
    auto.handleInput(':+1', 3)
    await nextTick()

    const suggestions = auto.suggestions.value
    expect(suggestions.length).toBeGreaterThan(0)

    const thumbsUp = suggestions.find(
      (s: any) => s.name === 'thumbs_up' || s.native === '👍',
    )
    expect(thumbsUp).toBeDefined()
    expect(thumbsUp?.native).toBe('👍')
  })

  it('does NOT surface thumbs_up for unrelated queries', async () => {
    const { auto } = setup()
    auto.handleInput(':grin', 5)
    await nextTick()
    const suggestions = auto.suggestions.value
    const thumbsUp = suggestions.find((s: any) => s.name === 'thumbs_up')
    expect(thumbsUp).toBeUndefined()
    // Sanity: should still find grinning_face though.
    const grinning = suggestions.find((s: any) => s.name === 'grinning_face')
    expect(grinning).toBeDefined()
  })

  // Regression: typing the CLOSING colon of a complete shortcode used to
  // re-open the suggestion list with an empty query, because the regex
  // matched the trailing `:` with an empty capture. That empty query then
  // matched every server custom emoji's name (`name.includes('') === true`)
  // and the user saw `:xd:`, `:wtf:`, `:whoa:`, etc. listed under `:joy:`.
  // The lookbehind `(?<=^|[^a-zA-Z0-9_+-])` now requires the colon to OPEN
  // a shortcode (preceded by start-of-string or non-identifier char), so a
  // closing `:` no longer triggers autosuggest.
  it('does NOT activate the trigger when typing the closing `:` of `:joy:`', () => {
    const { auto } = setup()
    auto.handleInput(':joy:', 5)
    expect(auto.state.value.isActive).toBe(false)
  })

  it('still activates the trigger for a NEW shortcode after a complete one', () => {
    const { auto } = setup()
    auto.handleInput(':joy: :gr', 9)
    expect(auto.state.value.isActive).toBe(true)
    expect(auto.state.value.triggerType).toBe('emoji')
    expect(auto.state.value.query).toBe('gr')
  })

  it('does NOT activate the trigger for a `:` glued onto a word like `text:j`', () => {
    const { auto } = setup()
    auto.handleInput('text:j', 6)
    expect(auto.state.value.isActive).toBe(false)
  })

  // Regression: MessageInput used to call `autoSuggest.handleInput(props.modelValue, ...)`
  // immediately after the editor emitted `update:modelValue`, but the v-model
  // round-trip is one tick slower than the synchronously-following
  // `cursor-position-changed` event. So `props.modelValue` was stale by
  // exactly one keystroke. Simulate that by calling handleInput with the
  // PREVIOUS value while the cursor has already moved past the new char:
  // the autosuggest then sees `:+` (query="+", length 1) instead of `:+1`
  // (query="+1", length 2), and the unified-emoji search is skipped entirely.
  // The fix reads the text from the editor ref, not the prop, so this no
  // longer happens - but we still want a test that fails if the upstream
  // call site is ever wired up to a lagged source again.
  it('with a fresh value, gates on actual cursor text not on the stale prop', async () => {
    const { auto } = setup()
    // Simulate the "stale" call. handleInput is called with `:+` but the
    // cursor is at position 3 (where the `1` would be). The autosuggest
    // should still read the value from the `value` argument, so this is
    // the *correct* behavior to validate: with a stale value the query
    // is `+` and no thumbs_up is surfaced. This documents the failure mode
    // - and the matching positive test below documents the fix.
    auto.handleInput(':+', 3)
    await nextTick()
    const staleSuggestions = auto.suggestions.value
    const thumbsUpStale = staleSuggestions.find((s: any) => s.name === 'thumbs_up')
    expect(thumbsUpStale).toBeUndefined()

    // Now the fix: pass the actual editor text (which `MessageInput` now
    // reads via `richEditorRef.value.getPlainText()`), and thumbs_up does
    // surface.
    auto.handleInput(':+1', 3)
    await nextTick()
    const freshSuggestions = auto.suggestions.value
    const thumbsUpFresh = freshSuggestions.find((s: any) => s.name === 'thumbs_up')
    expect(thumbsUpFresh).toBeDefined()
  })

  it('lists the default emoji before a custom emoji of its name; the default inserts its character', async () => {
    emojiCache.resolvedEmojis = {
      s1: {
        server_name: 'Lounge',
        emojis: [{ id: 'c0ffee00-0000-4000-8000-000000000001', name: 'thumbs_up', display_name: 'thumbs_up~1', url: 'https://x.test/up.png', server_id: 's1' }],
      },
    }
    const { auto, text } = setup()
    text.value = ':thumbs_up'
    auto.handleInput(':thumbs_up', 10)
    await nextTick()

    const both = auto.suggestions.value.filter((s: any) => s.name === 'thumbs_up')
    expect(both.map((s: any) => s.server_name)).toEqual(['Emojis', 'Lounge'])

    auto.selectSuggestion(both[0] as any)
    expect(text.value).toBe('👍 ')
  })

  it('inserts the custom emoji of a default emoji\'s name as name~1', async () => {
    emojiCache.resolvedEmojis = {
      s1: {
        server_name: 'Lounge',
        emojis: [{ id: 'c0ffee00-0000-4000-8000-000000000001', name: 'thumbs_up', display_name: 'thumbs_up~1', url: 'https://x.test/up.png', server_id: 's1' }],
      },
    }
    const { auto, text } = setup()
    text.value = ':thumbs_up'
    auto.handleInput(':thumbs_up', 10)
    await nextTick()
    auto.selectSuggestion(auto.suggestions.value.find((s: any) => s.server_name === 'Lounge') as any)
    expect(text.value).toBe(':thumbs_up~1: ')
  })
})

// The instance's emoji and the viewer's own are not server emoji: nothing loaded them until an
// emoji picker was opened, so `:name` did not offer them in a session that had not opened one.
describe('useAutoSuggest - instance and personal emoji for `:name`', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    isLoaded.value = true
    emojiCache.resolvedEmojis = {}
    emojiCache.loadPersonalEmojis.mockReset().mockResolvedValue(undefined)
    authContext.getCurrentContext.mockReset().mockResolvedValue({ profileId: 'p1' })
  })

  const setup = () => {
    const text = ref('')
    return useAutoSuggest(ref(null) as Ref<any>, () => text.value, (next: string) => { text.value = next }, { mode: 'chat' })
  }
  const loaded = () => vi.waitFor(() => expect(emojiCache.loadPersonalEmojis).toHaveBeenCalled())

  it('loads them for the viewer when the list opens, once while it stays open', async () => {
    const auto = setup()
    auto.handleInput(':b', 2)
    await loaded()
    expect(emojiCache.loadPersonalEmojis.mock.calls).toEqual([['p1']])

    auto.handleInput(':bl', 3)
    auto.handleInput(':blo', 4)
    await nextTick()
    expect(emojiCache.loadPersonalEmojis).toHaveBeenCalledTimes(1)

    auto.handleInput('plain text', 10)
    expect(auto.state.value.isActive).toBe(false)
    auto.handleInput('plain text :b', 13)
    await vi.waitFor(() => expect(emojiCache.loadPersonalEmojis).toHaveBeenCalledTimes(2))
  })

  it('offers an instance emoji once it is loaded, without a picker', async () => {
    emojiCache.loadPersonalEmojis.mockImplementation(async () => {
      emojiCache.resolvedEmojis = {
        'instance-emojis': {
          server_name: 'Harmony Emoji',
          emojis: [{ id: 'c0ffee00-0000-4000-8000-0000000000aa', name: 'blobcat', display_name: 'blobcat', url: 'https://db.test/blobcat.png', server_id: null }],
        },
      }
    })
    const auto = setup()
    auto.handleInput(':blob', 5)
    expect(auto.suggestions.value.find((s: any) => s.name === 'blobcat')).toBeUndefined()
    await loaded()
    auto.handleInput(':blobc', 6)
    await nextTick()
    const offered = auto.suggestions.value.find((s: any) => s.name === 'blobcat')
    expect(offered).toMatchObject({ id: 'c0ffee00-0000-4000-8000-0000000000aa', url: 'https://db.test/blobcat.png' })
  })

  it('signed out, loads the instance emoji alone', async () => {
    authContext.getCurrentContext.mockRejectedValue(new Error('no session'))
    const auto = setup()
    auto.handleInput(':b', 2)
    await loaded()
    expect(emojiCache.loadPersonalEmojis.mock.calls).toEqual([[null]])
  })

  it('a failed load leaves the list as it was', async () => {
    emojiCache.loadPersonalEmojis.mockRejectedValue(new Error('offline'))
    const auto = setup()
    auto.handleInput(':grin', 5)
    await loaded()
    await nextTick()
    expect(auto.state.value.isActive).toBe(true)
    expect(auto.suggestions.value.find((s: any) => s.name === 'grinning_face')).toBeDefined()
  })

  it('does not load them for a mention or a command', async () => {
    const auto = setup()
    auto.handleInput('@a', 2)
    auto.handleInput('/g', 2)
    await nextTick()
    await new Promise((r) => setTimeout(r, 20))
    expect(emojiCache.loadPersonalEmojis).not.toHaveBeenCalled()
  })
})
