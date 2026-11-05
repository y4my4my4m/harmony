/**
 * A picked '#' channel suggestion replaces the '#query' before the caret, wherever the '#'
 * sits in the text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { Ref } from 'vue'

const canMentionAll = ref(false)

vi.mock('@/stores/useEmojiCache', () => ({
  useEmojiCacheStore: () => ({ resolvedEmojis: {}, isInitialized: true, serverCaches: new Map() }),
}))

vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({
    currentServerId: 'server-1',
    currentChannelId: 'channel-1',
    servers: [],
    channels: [
      { id: 'c-zeta', name: 'zeta', type: 0, server_id: 'server-1' },
      { id: 'c-ops', name: 'dev-ops', type: 0, server_id: 'server-1' },
      { id: 'c-voice', name: 'zeta voice', type: 1, server_id: 'server-1' },
    ],
  }),
}))

vi.mock('@/services/userDataService', () => ({
  userDataService: { getUsersInContext: () => [], getAllUsers: () => [] },
}))

vi.mock('@/services/activityPubService', () => ({
  activityPubService: { searchUsers: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/services/RoleService', () => ({
  roleService: {
    getRolesForServer: vi.fn().mockResolvedValue([
      { id: 'role-everyone', name: 'everyone', is_default: true, mentionable: true },
      { id: 'role-crew', name: 'crew', is_default: false, mentionable: true },
      { id: 'role-reserve', name: 'reserve', is_default: false, mentionable: false },
    ]),
  },
}))

// MENTION_EVERYONE resolves in the channel; the server-wide check must not decide it.
vi.mock('@/composables/useChannelMessagePermissions', () => ({
  useChannelMessagePermissions: () => ({ canMentionEveryone: canMentionAll }),
}))

vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({
    hasCurrentUserPermission: (permission: string) =>
      permission === 'MENTION_EVERYONE' ? false : true,
    Permission: { MENTION_EVERYONE: 'MENTION_EVERYONE' },
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
    getSvgUrl: () => null,
    searchEmojis: () => [],
  }),
}))

vi.mock('@/services/bridgedChannelUsersService', () => ({
  clearBridgedUsersCache: vi.fn(),
  fetchBridgedChannelUsers: vi.fn().mockResolvedValue({ users: [] }),
}))

// Every query builder call returns the builder; awaiting it yields no rows.
vi.mock('@/supabase', () => {
  const builder: any = new Proxy(() => builder, {
    get: (_target, prop) =>
      prop === 'then'
        ? (resolve: (value: unknown) => void) => resolve({ data: [], error: null })
        : builder,
    apply: () => builder,
  })
  return { supabase: builder }
})

import { useAutoSuggest } from '../useAutoSuggest'

function pick(typed: string, caret = typed.length): string {
  const text = ref(typed)
  const auto = useAutoSuggest(
    ref(null) as Ref<any>,
    () => text.value,
    (next: string) => { text.value = next },
    { mode: 'chat', enableChannels: true },
  )
  auto.handleInput(typed, caret)
  expect(auto.state.value.triggerType).toBe('channel')
  expect(text.value.charAt(auto.state.value.triggerPosition)).toBe('#')
  const first = auto.suggestions.value[0]
  expect(first).toMatchObject({ isChannel: true })
  auto.selectSuggestion(first)
  return text.value
}

describe('useAutoSuggest channels', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('replaces a #query at the start', () => {
    expect(pick('#zet')).toBe('#zeta ')
  })

  it('replaces a #query after a space, a no-break space and a line break', () => {
    expect(pick('see #zet')).toBe('see #zeta ')
    expect(pick('see\u00a0#zet')).toBe('see\u00a0#zeta ')
    expect(pick('line\n#zet')).toBe('line\n#zeta ')
  })

  it('keeps the text after the caret, with the space already there', () => {
    expect(pick('ask #dev-o then', 'ask #dev-o'.length)).toBe('ask #dev-ops then')
    expect(pick('ask #dev-o\u00a0then', 'ask #dev-o'.length)).toBe('ask #dev-ops\u00a0then')
  })

  it('offers text channels only', () => {
    const auto = useAutoSuggest(ref(null) as Ref<any>, () => '#zeta', () => {}, { mode: 'chat', enableChannels: true })
    auto.handleInput('#zeta', 5)
    expect(auto.suggestions.value.map((s: any) => s.name)).toEqual(['zeta'])
  })
})
