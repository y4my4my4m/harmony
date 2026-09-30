/**
 * Role suggestions follow MENTION_EVERYONE: without it, @everyone and roles not
 * marked mentionable are not offered.
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
  useServerChannelStore: () => ({ currentServerId: 'server-1', currentChannelId: 'channel-1', servers: [] }),
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

vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({
    hasCurrentUserPermission: (permission: string) =>
      permission === 'MENTION_EVERYONE' ? canMentionAll.value : true,
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

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

async function roleSuggestions(): Promise<string[]> {
  const text = ref('')
  const auto = useAutoSuggest(
    ref(null) as Ref<any>,
    () => text.value,
    (next: string) => { text.value = next },
    { mode: 'chat' },
  )
  auto.handleInput('@r', 2)
  await flush()
  auto.handleInput('@r', 2)
  return auto.suggestions.value.filter((s: any) => s.isRole).map((s: any) => s.display_name)
}

describe('useAutoSuggest role mentions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('offers only mentionable, non-default roles without MENTION_EVERYONE', async () => {
    canMentionAll.value = false
    expect(await roleSuggestions()).toEqual(['crew'])
  })

  it('offers @everyone and unmentionable roles with MENTION_EVERYONE', async () => {
    canMentionAll.value = true
    expect((await roleSuggestions()).sort()).toEqual(['crew', 'everyone', 'reserve'])
  })
})
