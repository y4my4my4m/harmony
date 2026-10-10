import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import LiveReactionLayer from '../LiveReactionLayer.vue'
import { LIVE_REACTION_LIFETIME_MS, MAX_ON_SCREEN, liveReactions } from '@/services/voice/liveReactions'

// The layer floats the reactions aimed at its tile, never more than the
// on-screen cap, and fades them in place under reduced motion.

const bigSmile = { id: 'e1', name: 'big_smile', url: 'https://cdn.test/big_smile.png' }

// user7's name carries a custom emoji: the cache holds ':big_smile: y4my4m' as text and the
// resolved parts beside it.
vi.mock('@/composables/useUserData', async () => {
  const { ref } = await import('vue')
  return {
    useUserData: () => ({
      getUserAvatarUrl: (id: string) => ref(`/avatars/${id}.webp`),
      getUser: (id: string) => ref({ id }),
      getUserDisplayName: (id: string) => ref(id === 'user7' ? ':big_smile: y4my4m' : `Name ${id}`),
      getUserDisplayNameParts: (id: string) =>
        ref(id === 'user7' ? [{ type: 'emoji', emoji: bigSmile }, { type: 'text', text: ' y4my4m' }] : undefined),
      fetchUserProfile: async () => undefined,
    }),
  }
})
vi.mock('@/services/unifiedEmojiService', async () => {
  const { ref } = await import('vue')
  return {
    useUnifiedEmoji: () => ({
      resolveEmoji: (s: string) => ({ display: { type: 'text', content: s } }),
      isNativePack: ref(true),
      isLoaded: ref(true),
    }),
  }
})
vi.mock('@/services/userDataService', () => ({
  userDataService: { resolveDisplayNameParts: (text: string) => [{ type: 'text', text }] },
}))
vi.mock('@/utils/emojiUtils', () => ({ getEmojiUrl: (url: string) => url }))
vi.mock('@/utils/avatarUtils', () => ({ getAvatarUrl: (url: string) => url }))

const CUSTOM = 'party-id'
const members = new Set(Array.from({ length: 12 }, (_, i) => `user${i}`).concat('bob'))

const packet = (emoji: { kind: string; value: string }, target?: { id: string; source: string }) =>
  new TextEncoder().encode(JSON.stringify({
    type: 'live_reaction',
    emoji,
    ...(target ? { targetParticipant: target.id, targetSource: target.source } : {}),
  }))

let wrappers: VueWrapper[] = []
const mountLayer = (props: Record<string, unknown>) => {
  const w = mount(LiveReactionLayer, { props: props as any })
  wrappers.push(w)
  return w
}

beforeEach(() => {
  vi.useFakeTimers()
  liveReactions.connect({
    publish: () => true,
    toWireId: id => id,
    fromWireId: id => (members.has(id) ? id : null),
    localUserId: () => 'me',
    isParticipant: id => members.has(id),
    showOthers: () => true,
    resolveUnicode: value => ({ kind: 'text', text: value, label: value }),
    resolveCustom: id => (id === CUSTOM ? { src: '/emoji/party.webp', label: 'party' } : null),
    random: () => 0.25,
  })
})

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers = []
  liveReactions.disconnect()
  document.documentElement.removeAttribute('data-reduce-motion')
  vi.useRealTimers()
})

describe('LiveReactionLayer', () => {
  it('renders nothing until a reaction arrives', () => {
    const w = mountLayer({ userId: 'bob', source: 'screen' })
    expect(w.find('.live-reactions').exists()).toBe(false)
  })

  it('shows only the reactions aimed at its tile, with the sender', async () => {
    const screen = mountLayer({ userId: 'bob', source: 'screen' })
    const camera = mountLayer({ userId: 'bob', source: 'camera' })

    liveReactions.receive('user1', packet({ kind: 'unicode', value: '🔥' }, { id: 'bob', source: 'screen' }))
    liveReactions.receive('user2', packet({ kind: 'custom', value: CUSTOM }, { id: 'bob', source: 'screen' }))
    liveReactions.receive('bob', packet({ kind: 'unicode', value: '👍' }))
    await nextTick()

    const onScreen = screen.findAll('.live-reaction')
    expect(onScreen).toHaveLength(2)
    expect(onScreen[0].find('.live-reaction-glyph').text()).toBe('🔥')
    expect(onScreen[0].find('.live-reaction-name').text()).toBe('Name user1')
    expect(onScreen[0].find('.live-reaction-avatar').attributes('src')).toBe('/avatars/user1.webp')
    expect(onScreen[1].find('img.live-reaction-emoji').attributes('src')).toBe('/emoji/party.webp')
    expect(onScreen[1].attributes('data-sender-id')).toBe('user2')

    const onCamera = camera.findAll('.live-reaction')
    expect(onCamera).toHaveLength(1)
    expect(onCamera[0].text()).toContain('👍')
  })

  it('renders custom emoji in the sender\'s name as images, never the shortcode', async () => {
    const w = mountLayer({ userId: 'bob', source: 'screen' })
    liveReactions.receive('user7', packet({ kind: 'unicode', value: '🔥' }, { id: 'bob', source: 'screen' }))
    await nextTick()

    const name = w.find('.live-reaction-name')
    expect(name.text()).toBe('y4my4m')
    expect(name.text()).not.toContain(':big_smile:')
    const emoji = name.find('img.display-name-emoji')
    expect(emoji.attributes('src')).toBe('https://cdn.test/big_smile.png')
    expect(emoji.attributes('alt')).toBe(':big_smile:')
    expect(name.classes()).toContain('truncate')
  })

  it('is decorative and leaves the tile clickable', async () => {
    const w = mountLayer({ userId: 'bob', source: 'camera' })
    liveReactions.receive('bob', packet({ kind: 'unicode', value: '🎉' }))
    await nextTick()
    expect(w.find('.live-reactions').attributes('aria-hidden')).toBe('true')
  })

  it('drops the sender chip when compact', async () => {
    const w = mountLayer({ userId: 'bob', source: 'camera', compact: true })
    liveReactions.receive('bob', packet({ kind: 'unicode', value: '🎉' }))
    await nextTick()
    expect(w.find('.live-reaction').exists()).toBe(true)
    expect(w.find('.live-reaction-sender').exists()).toBe(false)
  })

  it(`never floats more than ${MAX_ON_SCREEN} at once`, async () => {
    const w = mountLayer({ userId: 'bob', source: 'screen' })
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 12; i++) {
        liveReactions.receive(`user${i}`, packet({ kind: 'unicode', value: '🔥' }, { id: 'bob', source: 'screen' }))
      }
    }
    await nextTick()
    expect(w.findAll('.live-reaction')).toHaveLength(MAX_ON_SCREEN)
  })

  it('clears each reaction after its flight', async () => {
    const w = mountLayer({ userId: 'bob', source: 'camera' })
    liveReactions.receive('bob', packet({ kind: 'unicode', value: '🎉' }))
    await nextTick()
    expect(w.findAll('.live-reaction')).toHaveLength(1)
    vi.advanceTimersByTime(LIVE_REACTION_LIFETIME_MS)
    await nextTick()
    expect(w.find('.live-reactions').exists()).toBe(false)
  })

  it('floats by default and fades in place under reduced motion', async () => {
    const w = mountLayer({ userId: 'bob', source: 'camera' })
    liveReactions.receive('bob', packet({ kind: 'unicode', value: '🎉' }))
    await nextTick()
    expect(w.find('.live-reaction').classes()).not.toContain('reduced')

    liveReactions.clear()
    document.documentElement.setAttribute('data-reduce-motion', 'true')
    liveReactions.receive('bob', packet({ kind: 'unicode', value: '🎉' }))
    await nextTick()
    expect(w.find('.live-reaction').classes()).toContain('reduced')
  })

  it('honours the system reduced-motion preference', async () => {
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList)
    const w = mountLayer({ userId: 'bob', source: 'camera' })
    liveReactions.receive('bob', packet({ kind: 'unicode', value: '🎉' }))
    await nextTick()
    expect(w.find('.live-reaction').classes()).toContain('reduced')
    matchMedia.mockRestore()
  })
})
