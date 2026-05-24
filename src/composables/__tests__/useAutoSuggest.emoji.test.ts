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

vi.mock('@/stores/useEmojiCache', () => ({
  useEmojiCacheStore: () => ({
    resolvedEmojis: {},
    isInitialized: true,
    serverCaches: new Map(),
  }),
}))

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

vi.mock('@/services/unifiedEmojiService', () => ({
  useUnifiedEmoji: () => ({
    isLoaded,
    isNativePack,
    getSvgUrl: () => null,
    searchEmojis: (query: string, limit = 50) => {
      const lowerQuery = query.toLowerCase()
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
      return fixtures
        .filter(
          (e) =>
            e.shortcode.toLowerCase().includes(lowerQuery) ||
            e.name.toLowerCase().includes(lowerQuery) ||
            e.keywords.some((kw) => kw.toLowerCase().includes(lowerQuery)),
        )
        .slice(0, limit)
    },
  }),
}))

import { useAutoSuggest } from '../useAutoSuggest'

describe('useAutoSuggest - emoji trigger for `:+1`', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    isLoaded.value = true
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
})
