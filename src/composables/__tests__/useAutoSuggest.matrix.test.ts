import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
const { fetchUsers } = vi.hoisted(() => ({ fetchUsers: vi.fn() }))
vi.mock('@/stores/useEmojiCache', () => ({ useEmojiCacheStore: () => ({ resolvedEmojis: {}, isInitialized: true, serverCaches: new Map() }) }))
vi.mock('@/stores/useServerChannel', async () => {
  const { reactive } = await import('vue')
  const store = reactive({ currentServerId: 'server', currentChannelId: 'channel', servers: [] })
  return { useServerChannelStore: () => store }
})
vi.mock('@/services/userDataService', () => ({ userDataService: {
  getUsersInContext: () => [{ id: 'native-uuid', username: 'sam', displayName: 'Native Sam', isLocal: true }], getAllUsers: () => [],
} }))
vi.mock('@/services/activityPubService', () => ({ activityPubService: { searchUsers: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/RoleService', () => ({ roleService: { getRolesForServer: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/composables/useChannelMessagePermissions', () => ({ useChannelMessagePermissions: () => ({ canMentionEveryone: ref(false) }) }))
vi.mock('@/composables/useServerPermissions', () => ({ useServerPermissions: () => ({ hasCurrentUserPermission: () => false, Permission: {}, isCurrentUserServerOwner: () => false }) }))
vi.mock('@/composables/useEmojiLoader', () => ({ ensureEmojiDataLoaded: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/services/unifiedEmojiService', () => ({ useUnifiedEmoji: () => ({ isLoaded: ref(true), isNativePack: ref(true), getSvgUrl: () => null, searchEmojis: () => [] }) }))
vi.mock('@/services/instanceConfig', () => ({ apiUrl: (path: string) => path }))
vi.mock('@/services/bridgedChannelUsersService', async original => ({ ...await original<typeof import('@/services/bridgedChannelUsersService')>(), fetchBridgedChannelUsers: fetchUsers }))
vi.mock('@/supabase', () => ({ supabase: { from: () => {
  const q: any = { select: () => q, eq: () => q, then: (resolve: any) => resolve({ data: [{ bot: { bot_type: 'bridge' } }], error: null }) }; return q
} } }))
import { useAutoSuggest } from '../useAutoSuggest'
import { useServerChannelStore } from '@/stores/useServerChannel'
const member = (id = '@sam:example.org') => ({ id, source: 'matrix', username: 'sam', displayName: 'Matrix Sam', avatarUrl: '' })
let wrapper: VueWrapper
let auto: ReturnType<typeof useAutoSuggest>
const text = ref('@sam')
beforeEach(() => { setActivePinia(createPinia()); fetchUsers.mockReset(); text.value = '@sam'; useServerChannelStore().currentChannelId = 'channel' })
afterEach(() => wrapper?.unmount())
function open() {
  wrapper = mount(defineComponent({ setup() {
    auto = useAutoSuggest(ref(document.createElement('textarea')), () => text.value, next => { text.value = next }, { mode: 'chat' })
    return () => h('div')
  } }))
  auto.handleInput(text.value, text.value.length)
}
describe('Matrix member mention picker', () => {
  it('offers native, Discord and full-MXID Matrix identities without conflating same usernames', async () => {
    fetchUsers.mockResolvedValue({ users: [member(), member('@sam:other.org'), { ...member('123'), source: 'discord' }] })
    open(); await flushPromises()
    const items = auto.suggestions.value
    expect(items.map(item => item.id)).toEqual(expect.arrayContaining(['native-uuid', 'matrix:@sam:example.org', 'matrix:@sam:other.org', 'discord:123']))
    const matrix = items.find(item => item.id === 'matrix:@sam:example.org')!
    expect(matrix).toMatchObject({ display_text: '@sam:example.org', mention_text: '<@matrix:%40sam%3Aexample.org>', isBridged: true, bridgeSource: 'matrix', user: { id: '@sam:example.org', domain: 'example.org', isLocal: false } })
    auto.selectSuggestion(matrix)
    expect(text.value).toBe('<@matrix:%40sam%3Aexample.org> ')
  })
  it('keeps the Discord compact source token unchanged', async () => {
    fetchUsers.mockResolvedValue({ users: [{ ...member('123'), source: 'discord' }] })
    open(); await flushPromises()
    auto.selectSuggestion(auto.suggestions.value.find(item => item.bridgeSource === 'discord')!)
    expect(text.value).toBe('@d!123:sam ')
  })
  it('rejects late member responses from the previous channel', async () => {
    let old!: (value: unknown) => void
    fetchUsers.mockReturnValueOnce(new Promise(resolve => { old = resolve })).mockResolvedValueOnce({ users: [member('@sam:new.org')] })
    open(); await flushPromises()
    useServerChannelStore().currentChannelId = 'new'; await flushPromises()
    auto.handleInput(text.value, text.value.length); await flushPromises()
    old({ users: [member('@sam:old.org')] }); await flushPromises()
    const ids = auto.suggestions.value.map(item => item.id)
    expect(ids).toContain('matrix:@sam:new.org')
    expect(ids).not.toContain('matrix:@sam:old.org')
  })
})
