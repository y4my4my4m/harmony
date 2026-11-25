/**
 * Bridged members in the member list: Discord and Matrix rows share one layout, one badge
 * and one grouping rule, in the whole list and in the windowed list of a large server. They are
 * those of the open channel, which belongs to the open server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toValue } from 'vue'
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const state = vi.hoisted(() => ({
  windowed: false,
  channels: [] as Array<{ id: string }>,
  asked: null as null | { channel: unknown; server: unknown },
}))

vi.mock('vue-i18n', async original => ({ ...await original<typeof import('vue-i18n')>(), useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => values?.platform ? `${key}:${values.platform}` : key, locale: { value: 'en' } }) }))
vi.mock('vue-router', async original => ({ ...await original<typeof import('vue-router')>(), useRouter: () => ({ push: vi.fn() }), useRoute: () => ({ path: '/channels/server/channel', params: {} }) }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ currentServerId: 'server', currentChannelId: 'channel', currentServer: { id: 'server', name: 'Club' }, channels: state.channels }) }))
vi.mock('@/composables/useBridgedChannelUsers', async () => {
  const { ref } = await import('vue')
  return { useBridgedChannelUsers: (channel: unknown, server: unknown) => {
    state.asked = { channel, server }
    return { hasBridge: ref(true), users: ref([
      { id: '@sam:example.org', username: 'sam', displayName: 'Matrix Sam', avatarUrl: '', source: 'matrix' },
      { id: '123', username: 'gus', displayName: 'Discord Gus', avatarUrl: '', source: 'discord', presenceStatus: 'online' },
      { id: '456', username: 'dee', displayName: 'Discord Dee', avatarUrl: '', source: 'discord' },
    ]) }
  } }
})
vi.mock('@/composables/useServerBots', async () => { const { ref } = await import('vue'); return { useServerBots: () => ({ bots: ref([]) }) } })
vi.mock('@/composables/useUserData', async original => {
  const actual = await original<typeof import('@/composables/useUserData')>(), { ref } = await import('vue')
  return { ...actual, useUserData: () => ({ ...actual.useUserData(), getUsersInContext: () => ref([{ id: 'native', username: 'native' }]) }) }
})
vi.mock('@/services/memberDirectory', async () => {
  const { reactive } = await import('vue')
  const directory = reactive({
    get mode() { return state.windowed ? 'windowed' : 'complete' },
    serverId: 'server', total: 1, query: '', listed: 0, answered: false,
    open: vi.fn(), close: vi.fn(), attach: vi.fn(), detach: vi.fn(), search: vi.fn(), showRanges: vi.fn(),
    slots: () => [{ type: 'header', groupKey: 'offline', count: 1 }, { type: 'member', groupKey: 'offline', index: 0, member: { id: 'native', username: 'native', display_name: 'Native' } }],
  })
  return { memberDirectory: directory }
})
vi.mock('@tanstack/vue-virtual', async () => {
  const { computed } = await import('vue')
  return { useVirtualizer: (options: any) => computed(() => ({
    getVirtualItems: () => Array.from({ length: options.value.count }, (_, index) => ({ index, key: index, start: index * 44, size: 44 })),
    getTotalSize: () => options.value.count * 44, measureElement: () => {}, scrollToIndex: () => {},
  })) }
})
import UserSidebar from '../UserSidebar.vue'

let wrapper: VueWrapper
async function mountSidebar(windowed: boolean) {
  state.windowed = windowed
  wrapper = shallowMount(UserSidebar, { global: { mocks: { $t: (key: string) => key }, stubs: { 'i18n-t': true } } })
  await flushPromises()
}
const row = (name: string) => wrapper.findAll('.bridged-user').find(item => item.text().includes(name))!
const groupOf = (name: string) => {
  const rows = wrapper.findAll('[data-member-index], .group-header')
  let group = ''
  for (const item of rows) {
    if (item.classes('group-header')) group = item.text()
    if (item.text().includes(name) && item.classes('bridged-user')) return group
  }
  return null
}

beforeEach(() => { setActivePinia(createPinia()); state.channels = [{ id: 'channel' }] })
afterEach(() => wrapper?.unmount())

describe.each([false, true])('bridged members (windowed: %s)', windowed => {
  beforeEach(() => mountSidebar(windowed))

  it('lists Discord and Matrix members with the same row and badge', () => {
    for (const [name, source, handle] of [['Matrix Sam', 'matrix', '@sam:example.org'], ['Discord Gus', 'discord', '@gus']]) {
      const item = row(name)
      expect(item.exists(), name).toBe(true)
      expect(item.getComponent({ name: 'BridgeSourceBadge' }).props('source')).toBe(source)
      expect(item.find('.user-domain').text()).toBe(handle)
      expect(item.attributes('title')).toBe(`${source === 'matrix' ? 'Matrix' : 'Discord'}: @${handle === '@gus' ? 'gus' : 'sam'}`)
      expect(item.find('.sr-only').text()).toContain(`chatNav.members.bridged:${source === 'matrix' ? 'Matrix' : 'Discord'}`)
    }
    expect(wrapper.find('svg.discord-bridge-icon').exists()).toBe(false)
  })

  it('finds people by name and by Matrix id, not by digits of a Discord id', async () => {
    const search = wrapper.get('input')
    const listed = () => wrapper.findAll('.bridged-user').map(item => item.text())
    await search.setValue('5')
    expect(listed()).toEqual([])
    await search.setValue('example.org')
    expect(listed()).toEqual([expect.stringContaining('Matrix Sam')])
    await search.setValue('gus')
    expect(listed()).toEqual([expect.stringContaining('Discord Gus')])
    await search.setValue('456')
    expect(listed()).toEqual([expect.stringContaining('Discord Dee')])
  })

  it('groups a Matrix member like a Discord member without presence', () => {
    expect(groupOf('Matrix Sam')).toBe(groupOf('Discord Dee'))
    expect(groupOf('Discord Gus')).not.toBe(groupOf('Discord Dee'))
    expect(row('Matrix Sam').classes()).toEqual(row('Discord Dee').classes())
  })

  it('opens the profile card of either platform', async () => {
    await row('Matrix Sam').trigger('click')
    expect(wrapper.getComponent({ name: 'UserProfileModal' }).props('user')).toMatchObject({ bridge_source: 'matrix', id: 'matrix:@sam:example.org' })
    expect(wrapper.getComponent({ name: 'UserProfileModal' }).props('show')).toBe(true)
    await row('Discord Gus').trigger('click')
    expect(wrapper.getComponent({ name: 'UserProfileModal' }).props('user')).toMatchObject({ bridge_source: 'discord', id: 'discord:123' })
  })
})

describe('the channel asked for', () => {
  it('is the open channel', async () => {
    await mountSidebar(false)
    expect(toValue(state.asked!.channel as () => unknown)).toBe('channel')
    expect(toValue(state.asked!.server as () => unknown)).toBe('server')
  })

  it('is none while the open channel still names one of the server left behind', async () => {
    state.channels = []
    await mountSidebar(false)
    expect(toValue(state.asked!.channel as () => unknown)).toBeNull()
  })
})
