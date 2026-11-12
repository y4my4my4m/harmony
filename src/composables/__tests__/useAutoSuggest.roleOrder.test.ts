/**
 * Roles, @everyone and @here are listed before people, whatever the names: the first entry,
 * selected when the list opens, is never a person who shares a role's name. A local person
 * named everyone or here is inserted with the host.
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

// Members named like the roles. The vitest VITE_DOMAIN is harmony.test.
const members = ['everyone', 'here', 'crew'].map((username) => ({
  id: `user-${username}`, username, displayName: username, avatarUrl: null, isLocal: true, domain: 'harmony.test',
}))

vi.mock('@/services/userDataService', () => ({
  userDataService: { getUsersInContext: () => members, getAllUsers: () => members, getMemberServerFields: (_s: string, u: string) => (u === 'user-crew' ? { nickname: 'Skipper', avatar_url: 'srv.png' } : null) },
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

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

async function suggestionsFor(typed: string, extra: Record<string, unknown> = {}): Promise<any[]> {
  const text = ref('')
  const auto = useAutoSuggest(
    ref(null) as Ref<any>,
    () => text.value,
    (next: string) => { text.value = next },
    { mode: 'chat', ...extra },
  )
  auto.handleInput(typed, typed.length)
  await flush()
  auto.handleInput(typed, typed.length)
  return auto.suggestions.value
}

const ids = (items: any[]) => items.map((s: any) => s.id)

describe('useAutoSuggest order of roles and people', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    canMentionAll.value = true
  })

  it('lists @everyone before the person named everyone, who keeps the host', async () => {
    const items = await suggestionsFor('@everyone')
    expect(ids(items)).toEqual(['role:role-everyone', 'user-everyone'])
    expect(items[1].display_text).toBe('@everyone@harmony.test')
  })

  it('lists @here before the person named here', async () => {
    expect(ids(await suggestionsFor('@here'))).toEqual(['role:here', 'user-here'])
  })

  it('lists a role before the member who shares its name', async () => {
    const items = await suggestionsFor('@crew')
    expect(ids(items)).toEqual(['role:role-crew', 'user-crew'])
    expect(items[1].display_text).toBe('@crew')
  })

  it('shows server nicknames in a server context and account names in a conversation', async () => {
    const inServer = await suggestionsFor('@skip')
    expect(inServer.map(s => s.display_name)).toEqual(['Skipper'])
    expect(inServer[0].profileServerId).toBe('server-1')
    // The store can still hold the last server while a DM is open: the composer says it is a DM.
    const inDm = await suggestionsFor('@crew', { profileServerId: () => null })
    const crew = inDm.find(s => s.id === 'user-crew')
    expect(crew.display_name).toBe('crew')
    expect(crew.avatar).toBeNull()
    expect(crew.profileServerId).toBeNull()
    expect(await suggestionsFor('@skip', { profileServerId: () => null })).toEqual([])
  })

  it('offers the person alone where the role is not offered', async () => {
    canMentionAll.value = false
    const items = await suggestionsFor('@everyone')
    expect(ids(items)).toEqual(['user-everyone'])
    expect(items[0].display_text).toBe('@everyone@harmony.test')
  })
})
