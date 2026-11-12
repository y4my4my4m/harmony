/**
 * A mention query is any text a display name holds: kana, kanji, Hangul, accents, spaces, and the
 * full-width @ of a Japanese input mode.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

const members = [
  { id: 'u1', username: 'hana', displayName: 'ひらがな', isLocal: true, domain: 'harmony.test' },
  { id: 'u2', username: 'kim', displayName: '김민수', isLocal: true, domain: 'harmony.test' },
  { id: 'u3', username: 'eugen', displayName: 'Eugen Rochko', isLocal: true, domain: 'harmony.test' },
  { id: 'u4', username: 'zoe', displayName: 'Zoé', isLocal: true, domain: 'harmony.test' },
  { id: 'u5', username: 'wide', displayName: 'ＡＢＣ', isLocal: true, domain: 'harmony.test' },
]

vi.mock('@/stores/useEmojiCache', () => ({
  useEmojiCacheStore: () => ({ resolvedEmojis: {}, isInitialized: true, serverCaches: new Map() }),
}))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: 'server-1', currentChannelId: 'channel-1', servers: [] }),
}))
vi.mock('@/services/userDataService', () => ({
  userDataService: {
    getUsersInContext: () => members,
    getAllUsers: () => members,
    fetchUserProfile: vi.fn(),
    // Server nicknames (server profiles): kim is 'Ｍｉｎｓｕ' in server-1.
    getMemberServerFields: (serverId: string, userId: string) =>
      (serverId === 'server-1' && userId === 'u2' ? { nickname: 'Ｍｉｎｓｕ' } : null),
  },
}))
vi.mock('@/services/activityPubService', () => ({
  activityPubService: { searchUsers: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/services/RoleService', () => ({
  roleService: { getRolesForServer: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/composables/useChannelMessagePermissions', () => ({
  useChannelMessagePermissions: () => ({ canMentionEveryone: ref(false) }),
}))
vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({
    hasCurrentUserPermission: () => false,
    Permission: {},
    isCurrentUserServerOwner: () => false,
  }),
}))
vi.mock('@/composables/useEmojiLoader', () => ({
  ensureEmojiDataLoaded: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/services/unifiedEmojiService', () => ({
  useUnifiedEmoji: () => ({
    isLoaded: ref(true),
    isNativePack: ref(true),
    getTwemojiUrl: () => null,
    searchEmojiHits: () => [],
  }),
}))
vi.mock('@/services/bridgedChannelUsersService', () => ({
  clearBridgedUsersCache: vi.fn(),
  fetchBridgedChannelUsers: vi.fn().mockResolvedValue({ users: [] }),
}))
vi.mock('@/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
    }),
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    channel: () => ({ on() { return this }, subscribe() { return this } }),
  },
}))

import { useAutoSuggest } from '@/composables/useAutoSuggest'

function setup(mode: 'chat' | 'activitypub' = 'chat', enableChannels = false) {
  let text = ''
  const written = { text: '', cursor: 0 }
  const suggest = useAutoSuggest(
    ref(null),
    () => text,
    (newText, cursor) => { written.text = newText; written.cursor = cursor ?? 0 },
    { mode, enableChannels },
  )
  const type = (value: string) => {
    text = value
    suggest.handleInput(value, value.length)
  }
  return { suggest, type, written }
}

const usernames = (s: ReturnType<typeof setup>['suggest']) => s.suggestions.value.map((i) => i.username)

describe('useAutoSuggest mention queries', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it.each([
    ['@ひらがな', ['hana']],
    ['@ひら', ['hana']],
    ['@김민', ['kim']],
    ['@zoe', ['zoe']],
    ['@Zoé', ['zoe']],
    ['@abc', ['wide']],
    ['@ABC', ['wide']],
    ['＠ひらがな', ['hana']],
    ['こんにちは @ひらがな', ['hana']],
    ['こんにちは　@ひらがな', ['hana']],
    ['first line\n@ひらがな', ['hana']],
  ])('%j finds %j', (typed, expected) => {
    const { suggest, type } = setup()
    type(typed)
    expect(suggest.state.value.isActive).toBe(true)
    expect(usernames(suggest)).toEqual(expected)
  })

  it('matches a server nickname with the same normalisation', () => {
    const { suggest, type } = setup()
    type('@minsu')
    expect(usernames(suggest)).toEqual(['kim'])
  })

  it('runs over a space in a display name', () => {
    const { suggest, type } = setup()
    type('@Eugen R')
    expect(suggest.state.value.query).toBe('Eugen R')
    expect(usernames(suggest)).toEqual(['eugen'])
  })

  it('offers nothing once the words match no one', () => {
    const { suggest, type } = setup()
    type('@Eugen hello')
    expect(suggest.suggestions.value).toEqual([])
  })

  it('leaves a later # and : to their own triggers', () => {
    const { suggest, type } = setup('chat', true)
    type('@hana #zet')
    expect(suggest.state.value.triggerType).toBe('channel')
    expect(suggest.state.value.query).toBe('zet')
    type('@hana :smi')
    expect(suggest.state.value.triggerType).toBe('emoji')
  })

  it('stops after four words', () => {
    const { suggest, type } = setup()
    type('@a b c d e')
    expect(suggest.state.value.isActive).toBe(false)
  })

  it('takes the last @ of the line', () => {
    const { suggest, type } = setup()
    type('@hana hi @ひらがな')
    expect(suggest.state.value.query).toBe('ひらがな')
    expect(usernames(suggest)).toEqual(['hana'])
  })

  it('ignores an @ inside a word and an escaped @', () => {
    const { suggest, type } = setup()
    type('mail@ひらがな')
    expect(suggest.state.value.isActive).toBe(false)
    type('\\@ひらがな')
    expect(suggest.state.value.isActive).toBe(false)
  })

  it('replaces the whole query with the username, spaces included', () => {
    const { suggest, type, written } = setup()
    type('hi @Eugen Ro')
    suggest.selectSuggestion(suggest.suggestions.value[0])
    expect(written.text).toBe('hi @eugen ')
    expect(written.cursor).toBe('hi @eugen '.length)
  })

  it('replaces a kana query typed with the full-width @, keeping the text after it', () => {
    const { suggest, written } = setup()
    const text = '＠ひら tail'
    suggest.handleInput(text, 3)
    const typed = setup()
    typed.type('＠ひら')
    typed.suggest.selectSuggestion(typed.suggest.suggestions.value[0])
    expect(typed.written.text).toBe('@hana ')
    expect(suggest.state.value.query).toBe('ひら')
    expect(written.text).toBe('')
  })

  it('keeps ActivityPub queries to one word', () => {
    const { suggest, type } = setup('activitypub')
    type('@ひらがな')
    expect(suggest.state.value.query).toBe('ひらがな')
    type('@Eugen R')
    expect(suggest.state.value.isActive).toBe(false)
  })

  it('offers no emoji after an escaped colon', () => {
    const { suggest, type } = setup()
    type('\\:smi')
    expect(suggest.state.value.isActive).toBe(false)
  })
})
