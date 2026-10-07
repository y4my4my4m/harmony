/**
 * Suggestion popup placement: anchored to the caret of the editor the
 * suggestion belongs to, below it or above it when the space below is short.
 * Discord emoji from the recent list are suggested and insert as their token.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick, type Ref } from 'vue'

vi.mock('@/stores/useEmojiCache', () => ({
  useEmojiCacheStore: () => ({ resolvedEmojis: {}, isInitialized: true, serverCaches: new Map() }),
}))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: null, currentChannelId: null, servers: [], channels: [] }),
}))
vi.mock('@/services/userDataService', () => ({
  userDataService: { getUsersInContext: () => [], getAllUsers: () => [] },
}))
vi.mock('@/services/activityPubService', () => ({
  activityPubService: { searchUsers: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/services/RoleService', () => ({
  roleService: { getRolesForServer: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({
    hasCurrentUserPermission: () => true,
    Permission: {},
    isCurrentUserServerOwner: ref(false),
  }),
}))
vi.mock('@/composables/useEmojiLoader', () => ({ ensureEmojiDataLoaded: vi.fn() }))
vi.mock('@/services/unifiedEmojiService', () => ({
  useUnifiedEmoji: () => ({
    isLoaded: ref(false),
    isNativePack: ref(true),
    getSvgUrl: () => null,
    searchEmojis: () => [],
  }),
}))

const ID = '1376980620600672316'
const frequentEmojis = ref([
  { id: `discord:heh:${ID}`, name: `discord:heh:${ID}`, url: `https://cdn.discordapp.com/emojis/${ID}.png`, count: 2, lastUsed: 0 },
  { id: 'e-uuid', name: 'har_wink', url: 'https://cdn.example/w.webp', count: 1, lastUsed: 0 },
])
vi.mock('@/composables/useFrequentEmojis', () => ({
  useFrequentEmojis: () => ({ frequentEmojis }),
}))

import {
  inputDomElement,
  placeSuggestionPopup,
  suggestionAnchorRect,
  useAutoSuggest,
} from '../useAutoSuggest'

const VIEWPORT = { width: 1200, height: 800 }
const POPUP = { width: 280, height: 200 }

function rect(left: number, top: number, bottom: number): DOMRect {
  return { left, top, bottom, right: left + 10, width: 10, height: bottom - top, x: left, y: top, toJSON: () => ({}) } as DOMRect
}

describe('placeSuggestionPopup', () => {
  it('opens below the caret when it fits', () => {
    expect(placeSuggestionPopup({ left: 300, top: 100, bottom: 120 }, POPUP, VIEWPORT)).toEqual({ x: 288, y: 124 })
  })

  it('opens above the caret when the space below is short', () => {
    expect(placeSuggestionPopup({ left: 300, top: 740, bottom: 760 }, POPUP, VIEWPORT)).toEqual({ x: 288, y: 536 })
  })

  it('takes the roomier side and stays inside the viewport when neither fits', () => {
    const tall = { width: 280, height: 700 }
    expect(placeSuggestionPopup({ left: 300, top: 100, bottom: 120 }, tall, VIEWPORT).y).toBe(124)
    expect(placeSuggestionPopup({ left: 300, top: 600, bottom: 620 }, tall, VIEWPORT).y).toBe(16)
  })

  it('clamps x to the viewport inset', () => {
    expect(placeSuggestionPopup({ left: 1190, top: 100, bottom: 120 }, POPUP, VIEWPORT).x).toBe(1200 - 280 - 16)
    expect(placeSuggestionPopup({ left: 0, top: 100, bottom: 120 }, POPUP, VIEWPORT).x).toBe(16)
  })
})

describe('suggestionAnchorRect', () => {
  let getClientRects: unknown

  beforeEach(() => {
    getClientRects = (Range.prototype as unknown as { getClientRects?: unknown }).getClientRects
  })
  afterEach(() => {
    ;(Range.prototype as unknown as { getClientRects?: unknown }).getClientRects = getClientRects
    document.body.innerHTML = ''
    window.getSelection()?.removeAllRanges()
  })

  function editorWithCaret() {
    const el = document.createElement('div')
    el.setAttribute('contenteditable', 'true')
    el.textContent = 'hello :he'
    document.body.appendChild(el)
    el.getBoundingClientRect = () => rect(40, 300, 360)
    const range = document.createRange()
    range.setStart(el.firstChild!, 9)
    range.collapse(true)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    return el
  }

  it('measures the caret inside the editor', () => {
    const el = editorWithCaret()
    ;(Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => [rect(130, 320, 338)]
    expect(suggestionAnchorRect(el)).toEqual({ left: 130, top: 320, bottom: 338 })
  })

  it('measures the editor box when the selection is in another element', () => {
    const el = editorWithCaret()
    const other = document.createElement('div')
    other.textContent = 'main composer'
    document.body.appendChild(other)
    const range = document.createRange()
    range.setStart(other.firstChild!, 2)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    ;(Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => [rect(900, 700, 720)]
    expect(suggestionAnchorRect(el)).toEqual({ left: 40, top: 300, bottom: 360 })
  })

  it('resolves a component ref to its root element', () => {
    const el = document.createElement('div')
    expect(inputDomElement({ $el: el })).toBe(el)
    expect(inputDomElement(el)).toBe(el)
    expect(inputDomElement(null)).toBeNull()
  })
})

describe('useAutoSuggest Discord emoji from recents', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function setup() {
    const text = ref('')
    const auto = useAutoSuggest(
      ref(null) as Ref<any>,
      () => text.value,
      (next: string) => { text.value = next },
      { mode: 'chat' },
    )
    return { auto, text }
  }

  it('suggests a recent Discord emoji by name and inserts its token', async () => {
    const { auto, text } = setup()
    text.value = 'ok :he'
    auto.handleInput(text.value, text.value.length)
    await nextTick()
    const discord = auto.suggestions.value.find((s) => s.server_name === 'Discord')
    expect(discord).toMatchObject({ name: 'heh', url: `https://cdn.discordapp.com/emojis/${ID}.png` })
    auto.selectSuggestion(discord!)
    expect(text.value).toBe(`ok :discord:heh:${ID}: `)
  })

  it('does not list server emoji from recents as Discord emoji', async () => {
    const { auto } = setup()
    auto.handleInput(':har', 4)
    await nextTick()
    expect(auto.suggestions.value.filter((s) => s.server_name === 'Discord')).toHaveLength(0)
  })
})
