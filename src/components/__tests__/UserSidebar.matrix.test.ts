import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
vi.mock('vue-i18n', async original => ({ ...await original<typeof import('vue-i18n')>(), useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }) }))
vi.mock('vue-router', async original => ({ ...await original<typeof import('vue-router')>(), useRouter: () => ({ push: vi.fn() }), useRoute: () => ({ path: '/channels/server/channel', params: {} }) }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ currentServerId: 'server', currentChannelId: 'channel', currentServer: { id: 'server', name: 'Club' } }) }))
vi.mock('@/composables/useBridgedChannelUsers', async () => {
  const { ref } = await import('vue')
  return { useBridgedChannelUsers: () => ({ hasBridge: ref(true), users: ref([
    { id: '@sam:example.org', username: 'sam', displayName: 'Matrix Sam', avatarUrl: '', source: 'matrix' },
    { id: '123', username: 'sam', displayName: 'Discord Sam', avatarUrl: '', source: 'discord', presenceStatus: 'online' },
  ]) }) }
})
vi.mock('@/composables/useServerBots', async () => { const { ref } = await import('vue'); return { useServerBots: () => ({ bots: ref([]) }) } })
vi.mock('@/composables/useUserData', async original => {
  const actual = await original<typeof import('@/composables/useUserData')>(), { ref } = await import('vue')
  return { ...actual, useUserData: () => ({ ...actual.useUserData(), getUsersInContext: () => ref([{ id: 'native', username: 'native' }]) }) }
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
beforeEach(async () => {
  setActivePinia(createPinia())
  wrapper = shallowMount(UserSidebar, { global: { mocks: { $t: (key: string) => key }, stubs: { 'i18n-t': true } } })
  await flushPromises()
})
afterEach(() => wrapper?.unmount())
describe('Matrix channel members', () => {
  it('shows an external MXID and neutral presence, opening only the read-only Matrix card', async () => {
    const row = wrapper.get('[title="@sam:example.org"]')
    expect(row.text()).toContain('Matrix Sam')
    expect(row.text()).toContain('@sam:example.org')
    expect(row.classes()).not.toContain('offline-user')
    expect(row.getComponent({ name: 'Avatar' }).props('status')).toBeUndefined()
    await row.trigger('click')
    expect(wrapper.getComponent({ name: 'MatrixBridgedProfile' }).props('user')).toMatchObject({ source: 'matrix', id: '@sam:example.org' })
    expect(wrapper.getComponent({ name: 'UserProfileModal' }).props('show')).toBe(false)
  })
  it('still opens the legacy Discord card and supports searching a Matrix homeserver', async () => {
    await wrapper.get('[title="Discord: @sam"]').trigger('click')
    expect(wrapper.getComponent({ name: 'UserProfileModal' }).props('user')).toMatchObject({ id: 'discord:123', bridge_source: 'discord' })
    await wrapper.get('[data-testid="member-search"]').setValue('example.org')
    expect(wrapper.find('[title="@sam:example.org"]').exists()).toBe(true)
    expect(wrapper.find('[title="Discord: @sam"]').exists()).toBe(false)
  })
})
