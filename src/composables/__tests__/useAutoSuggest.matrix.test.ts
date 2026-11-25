import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
const { fetchUsers, installed } = vi.hoisted(() => ({
  fetchUsers: vi.fn(),
  installed: { rows: [] as unknown[], lacks: null as string | null, error: null as { code: string } | null, selects: [] as string[] },
}))
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
vi.mock('@/services/instanceConfig', () => ({
  apiUrl: (path: string) => path,
  getStoredInstance: () => null,
  isTauriRuntime: () => false,
  refreshStoredInstance: async () => null,
}))
vi.mock('@/services/bridgedChannelUsersService', async original => ({ ...await original<typeof import('@/services/bridgedChannelUsersService')>(), fetchBridgedChannelUsers: fetchUsers }))
// Every query answers the installed bots; a select naming the column the instance lacks is refused, as PostgREST refuses it.
vi.mock('@/supabase', () => {
  let columns = ''
  const answer = () => {
    if (installed.error) return { data: null, error: installed.error }
    if (installed.lacks && columns.includes(installed.lacks)) return { data: null, error: { code: '42703', message: `column bots_1.${installed.lacks} does not exist` } }
    return { data: installed.rows, error: null }
  }
  const builder: any = new Proxy(() => builder, {
    get: (_target, prop) => {
      if (prop === 'then') return (resolve: (value: unknown) => void) => resolve(answer())
      if (prop === 'select') return (selected: string) => { columns = selected; installed.selects.push(selected); return builder }
      return builder
    },
    apply: () => builder,
  })
  return { supabase: builder }
})
import { useAutoSuggest } from '../useAutoSuggest'
import { useServerChannelStore } from '@/stores/useServerChannel'
const member = (id = '@sam:example.org') => ({ id, source: 'matrix', username: 'sam', displayName: 'Matrix Sam', avatarUrl: '' })
let wrapper: VueWrapper
let auto: ReturnType<typeof useAutoSuggest>
const text = ref('@sam')
const MATRIX_BOT = { bot: { bot_type: 'bot', bridge_platform: 'matrix' } }
let servers = 0
beforeEach(() => {
  setActivePinia(createPinia()); fetchUsers.mockReset(); text.value = '@sam'
  Object.assign(installed, { rows: [MATRIX_BOT], lacks: null, error: null, selects: [] })
  // The bridge bot check is cached per server for the whole file.
  Object.assign(useServerChannelStore(), { currentServerId: `server-${++servers}`, currentChannelId: 'channel' })
})
afterEach(() => wrapper?.unmount())
function open() {
  wrapper = mount(defineComponent({ setup() {
    auto = useAutoSuggest(ref(document.createElement('textarea')), () => text.value, next => { text.value = next }, { mode: 'chat' })
    return () => h('div')
  } }))
  auto.handleInput(text.value, text.value.length)
}
describe('bridged member mention picker', () => {
  it('offers native, Discord and Matrix people alike without conflating same usernames', async () => {
    fetchUsers.mockResolvedValue({ users: [member(), member('@sam:other.org'), { ...member('123'), source: 'discord' }] })
    open(); await flushPromises()
    const items = auto.suggestions.value
    expect(items.map(item => item.id)).toEqual(expect.arrayContaining(['native-uuid', 'matrix:@sam:example.org', 'matrix:@sam:other.org', 'discord:123']))
    const matrix = items.find(item => item.id === 'matrix:@sam:example.org')!
    expect(matrix).toMatchObject({ display_name: 'Matrix Sam', username: 'sam', display_text: '@sam', mention_text: '<@matrix:%40sam%3Aexample.org>', isBridged: true, bridgeSource: 'matrix', user: { id: '@sam:example.org', domain: 'example.org', isLocal: false } })
    const discord = items.find(item => item.id === 'discord:123')!
    expect(discord).toMatchObject({ display_name: 'Matrix Sam', username: 'sam', display_text: '@sam', isBridged: true, bridgeSource: 'discord' })
    auto.selectSuggestion(matrix)
    expect(text.value).toBe('<@matrix:%40sam%3Aexample.org> ')
  })
  it.each([
    ['a Matrix bridge bot', [MATRIX_BOT]],
    ['a Discord bridge bot', [{ bot: { bot_type: 'bridge', bridge_platform: null } }]],
    ['a private bot of another member, whose row RLS hides', [{ bot: null }]],
  ])('asks for bridged people on a server with only %s', async (_name, rows) => {
    installed.rows = rows
    fetchUsers.mockResolvedValue({ users: [member()] })
    open(); await flushPromises()
    expect(fetchUsers).toHaveBeenCalledExactlyOnceWith('channel')
    expect(auto.suggestions.value.map(item => item.id)).toContain('matrix:@sam:example.org')
  })
  it.each([
    ['no bot', []],
    ['an ordinary bot', [{ bot: { bot_type: 'bot', bridge_platform: null } }]],
  ])('asks for none on a server with %s', async (_name, rows) => {
    installed.rows = rows
    open(); await flushPromises()
    expect(fetchUsers).not.toHaveBeenCalled()
  })
  // The native app opens instances before 1.9.8, whose bots have no bridge_platform (20261117900001).
  it('on an instance without bots.bridge_platform, still offers Discord people', async () => {
    installed.lacks = 'bridge_platform'
    installed.rows = [{ bot: { bot_type: 'bridge' } }]
    fetchUsers.mockResolvedValue({ users: [{ ...member('123'), source: 'discord' }] })
    open(); await flushPromises()
    expect(fetchUsers).toHaveBeenCalledExactlyOnceWith('channel')
    expect(auto.suggestions.value.map(item => item.id)).toContain('discord:123')
  })
  it('on an instance without it, an ordinary bot is no bridge', async () => {
    installed.lacks = 'bridge_platform'
    installed.rows = [{ bot: { bot_type: 'bot' } }]
    open(); await flushPromises()
    expect(fetchUsers).not.toHaveBeenCalled()
  })
  it('asks once where the column is there, and no second time for another failure', async () => {
    fetchUsers.mockResolvedValue({ users: [] })
    open(); await flushPromises()
    expect(installed.selects.filter(select => select.includes('bot_type'))).toHaveLength(1)
    wrapper.unmount()
    Object.assign(installed, { selects: [], error: { code: '42501' } })
    Object.assign(useServerChannelStore(), { currentServerId: `server-${++servers}` })
    open(); await flushPromises()
    expect(installed.selects.filter(select => select.includes('bot_type'))).toHaveLength(1)
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
