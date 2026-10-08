/**
 * Emoji autosuggest, picker (EmojiPickerContent) and popup (EmojiPopup) timing benchmark.
 *
 * Fixture: the bundled unicode set (public/assets/emojis/unicode-emoji-data.json,
 * 1906 entries) plus 5000 custom emoji over 10 servers loaded through the real
 * emoji cache store. Timings print as `[emoji-bench]` lines; the budgets are
 * loose ceilings that catch an order-of-magnitude regression on slow CI.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ref, nextTick, type Component } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import type { Emoji } from '@/types'

vi.mock('@/services/emojiIndexedDBCache', () => ({
  getCachedStaticEmojiData: vi.fn(async () => null),
  setCachedStaticEmojiData: vi.fn(async () => {}),
  getAllCachedServerEmojis: vi.fn(async () => []),
  setCachedServerEmojis: vi.fn(async () => {}),
  removeCachedServerEmojis: vi.fn(async () => {}),
  getCachedServerEmojis: vi.fn(async () => null),
}))
vi.mock('@/services/userDataService', () => ({
  userDataService: { getUsersInContext: () => [], getAllUsers: () => [], reResolveAllDisplayNames: () => {} },
}))
vi.mock('@/services/activityPubService', () => ({ activityPubService: { searchUsers: vi.fn(async () => []) } }))
vi.mock('@/services/RoleService', () => ({ roleService: { getServerRoles: vi.fn(async () => []) } }))
vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({ hasCurrentUserPermission: () => true, Permission: {}, isCurrentUserServerOwner: () => false }),
}))
vi.mock('@/composables/useEmojiLoader', () => ({
  ensureEmojiDataLoaded: vi.fn(async () => {}),
  triggerEmojiDataLoad: vi.fn(),
}))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: 'srv-0', currentChannelId: null, servers: [], channels: [] }),
}))
vi.mock('@/stores/useInstanceSettings', () => ({ useInstanceSettingsStore: () => ({ settings: {} }) }))
vi.mock('@/composables/useFrequentEmojis', () => ({
  useFrequentEmojis: () => ({
    frequentEmojis: ref([]),
    topEmojisForPicker: ref([]),
    hasFrequentEmojis: ref(false),
    recordEmojiUsage: vi.fn(),
    removeFrequentEmoji: vi.fn(),
    isFrequentEmoji: () => false,
  }),
}))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentContext: vi.fn(async () => ({ profileId: null })) },
}))
vi.mock('@/composables/usePopupPositioning', () => ({
  usePopupPositioning: () => ({ positionStyle: ref({}), updatePosition: vi.fn() }),
}))
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerReaction: vi.fn() }) }))
vi.mock('@/services/EmojiFavoriteService', () => ({
  emojiFavoriteService: { initializeCache: vi.fn(async () => {}), getFavorites: vi.fn(async () => []), toggleFavorite: vi.fn() },
}))

import { useEmojiCacheStore } from '@/stores/useEmojiCache'
import { loadEmojiData, setEmojiPack } from '@/services/unifiedEmojiService'
import { useAutoSuggest } from '@/composables/useAutoSuggest'
import EmojiPickerContent from '@/components/EmojiPickerContent.vue'
import EmojiPopup from '@/components/EmojiPopup.vue'

const CUSTOM_PER_SERVER = 500
const SERVERS = 10
const WORDS = ['cat', 'blob', 'party', 'smile', 'pepe', 'wave', 'heart', 'fire', 'dance', 'joyful', 'sad', 'kek', 'love', 'thonk', 'yes']

function customEmoji(server: number, i: number): Emoji {
  const word = WORDS[(server * CUSTOM_PER_SERVER + i) % WORDS.length]
  return {
    id: `00000000-0000-4000-8000-${String(server * CUSTOM_PER_SERVER + i).padStart(12, '0')}`,
    name: `${word}_${server}_${i}`,
    url: `https://harmony.test/emoji/${server}/${i}.png`,
    server_id: `srv-${server}`,
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

const KEYSTROKES = [':j', ':jo', ':joy', ':s', ':sm', ':smi', ':smil', ':smile', ':th', ':thu', ':thumbs', ':f', ':fi', ':fir', ':fire']

let realFetch: typeof fetch
let realIO: typeof IntersectionObserver | undefined
// Sections currently in the DOM that the viewport mock has shown.
let shown: Element[] = []

beforeAll(async () => {
  const json = readFileSync(resolve(__dirname, '../../../public/assets/emojis/unicode-emoji-data.json'), 'utf8')
  realFetch = globalThis.fetch
  globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('unicode-emoji-data.json')) return new Response(json, { status: 200 })
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch

  // Viewport mock: at most three mounted sections are visible at once, roughly
  // a popup-sized viewport before any scrolling. Later sections stay placeholders.
  realIO = (globalThis as any).IntersectionObserver
  ;(globalThis as any).IntersectionObserver = class {
    constructor(private cb: IntersectionObserverCallback) {}
    observe(el: Element) {
      shown = shown.filter(e => e.isConnected)
      if (shown.length < 3) {
        shown.push(el)
        this.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as any)
      }
    }
    disconnect() {}
    unobserve() {}
  }

  setActivePinia(createPinia())
  const store = useEmojiCacheStore()
  for (let s = 0; s < SERVERS; s++) {
    const list: Emoji[] = []
    for (let i = 0; i < CUSTOM_PER_SERVER; i++) list.push(customEmoji(s, i))
    store.updateServerCache(`srv-${s}`, list, { name: `Server ${s}` }, false)
  }
  store.rebuildResolvedEmojis()
  store.isInitialized = true
  setEmojiPack('twemoji')
  await loadEmojiData()
})

afterAll(() => {
  globalThis.fetch = realFetch
  ;(globalThis as any).IntersectionObserver = realIO
})

describe('emoji autosuggest benchmark (5000 custom + unicode set)', () => {
  it('computes suggestions per keystroke', () => {
    const text = ref('')
    const input = ref<any>(null)
    const { suggestions, handleInput } = useAutoSuggest(input, () => text.value, undefined, { mode: 'chat' })

    // Warm-up builds the lazy unicode and custom indexes; timed separately.
    const w0 = performance.now()
    text.value = ':aa'
    handleInput(':aa', 3)
    void suggestions.value
    console.log(`[emoji-bench] autosuggest first query (index build)=${(performance.now() - w0).toFixed(2)}ms`)

    const perKey: number[] = []
    for (let round = 0; round < 5; round++) {
      for (const q of KEYSTROKES) {
        text.value = q
        const t0 = performance.now()
        handleInput(q, q.length)
        void suggestions.value
        perKey.push(performance.now() - t0)
      }
    }
    const m = median(perKey)
    console.log(`[emoji-bench] autosuggest keystroke median=${m.toFixed(3)}ms max=${Math.max(...perKey).toFixed(3)}ms n=${perKey.length}`)

    text.value = ':joy'
    handleInput(':joy', 4)
    console.log(`[emoji-bench] :joy top3 = ${suggestions.value.slice(0, 3).map(s => `${s.emoji?.native ?? s.id}(${s.name})`).join(' ')}`)
    expect(suggestions.value[0].emoji?.native).toBe('😂')
    expect(suggestions.value[0].name).toBe('joy')
    // Custom emoji stay listed with their server label, current server first.
    const custom = suggestions.value.find(s => s.server_name !== 'Emojis')
    expect(custom?.name).toMatch(/^joyful_/)
    expect(custom?.server_name).toBe('Server 0')
    expect(m).toBeLessThan(50)
  })
})

async function benchPicker(label: string, component: Component) {
  shown = []
  const t0 = performance.now()
  const wrapper = mount(component, {
    global: {
      stubs: { teleport: true, ServerIcon: true, LoadingSpinner: true, Icon: true, EmptyState: true },
      mocks: { $t: (key: string) => key },
    },
  })
  await nextTick()
  const mountMs = performance.now() - t0
  const imgsAtMount = wrapper.findAll('img').length
  console.log(`[emoji-bench] ${label} mount=${mountMs.toFixed(1)}ms imgs=${imgsAtMount} lazyImgs=${wrapper.findAll('img[loading="lazy"]').length}`)

  const input = wrapper.get('input.search-input')
  // Fake timers drive the search debounce deterministically.
  vi.useFakeTimers()
  const inputMs: number[] = []
  const totalMs: number[] = []
  for (let round = 0; round < 3; round++) {
    for (const q of ['s', 'sm', 'smi', 'smil', 'smile', 'smil', 'smi', 'sm', 's', '']) {
      const k0 = performance.now()
      await input.setValue(q)
      await nextTick()
      const k1 = performance.now()
      vi.advanceTimersByTime(150)
      await nextTick()
      await nextTick()
      inputMs.push(k1 - k0)
      totalMs.push(performance.now() - k0)
    }
  }
  // Burst: five keystrokes inside the debounce window, then one settle.
  const b0 = performance.now()
  for (const q of ['h', 'he', 'hea', 'hear', 'heart']) {
    await input.setValue(q)
    await nextTick()
  }
  vi.advanceTimersByTime(150)
  await nextTick()
  await nextTick()
  const burstMs = performance.now() - b0
  await input.setValue('smile')
  vi.advanceTimersByTime(150)
  await nextTick()
  await nextTick()
  vi.useRealTimers()
  const imgsSmile = wrapper.findAll('img').length
  console.log(`[emoji-bench] ${label} query input-median=${median(inputMs).toFixed(2)}ms total-median=${median(totalMs).toFixed(2)}ms total-max=${Math.max(...totalMs).toFixed(2)}ms burst5=${burstMs.toFixed(1)}ms imgs('smile')=${imgsSmile}`)
  expect(imgsSmile).toBeGreaterThan(0)
  wrapper.unmount()
}

describe('emoji picker benchmark (5000 custom + unicode set)', () => {
  it('EmojiPickerContent mounts and filters', async () => {
    await benchPicker('picker', EmojiPickerContent)
  })

  it('EmojiPopup mounts and filters', async () => {
    await benchPicker('popup', EmojiPopup)
  })
})
