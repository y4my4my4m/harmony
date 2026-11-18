/** ServerDropdown.vue: the Bridge privacy entry of the channel-list server menu. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, ref } from 'vue'
import { supabase } from '@/supabase'

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ name: 'Chat', params: {}, fullPath: '/chat' }),
}))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: ref('en') }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/composables/useLeaveServer', () => ({ useLeaveServer: () => ({ leaveServer: vi.fn(), isOwner: () => false }) }))
vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({
    serverSettingsPermissions: computed(() => ({ canEditBasicInfo: false, canViewSettings: true })),
    channelPermissions: computed(() => ({ canCreateChannels: false, canCreateCategories: false })),
  }),
}))

import ServerDropdown from '../ServerDropdown.vue'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useBridgePrivacyStore } from '@/stores/useBridgePrivacy'

const rpc = vi.mocked(supabase.rpc)
const privacy = (discord: boolean, matrix: boolean) => ({
  discord: { bridged: discord, opted_out: false },
  matrix: { bridged: matrix, opted_out: false },
})

let wrapper: VueWrapper
const mountMenu = (isVisible = true) => {
  wrapper = mount(ServerDropdown, {
    props: { serverId: 's1', isVisible },
    attachTo: document.body,
    global: {
      mocks: { $t: (key: string) => key },
      directives: { 'click-outside': {} },
      stubs: { ServerCopyBanner: true },
    },
  })
}
const entry = () => wrapper.find('[data-testid="server-bridge-privacy"]')
const reads = () => rpc.mock.calls.filter(([name]) => name === 'bridge_member_privacy')

beforeEach(() => {
  setActivePinia(createPinia())
  rpc.mockReset()
  useServerChannelStore().servers = [{ id: 's1', name: 'Club', is_local_server: true } as never]
  useServerChannelStore().currentServerId = 's1'
})
afterEach(() => wrapper?.unmount())

describe('ServerDropdown bridge privacy', () => {
  it('offers Bridge privacy once the server reads as bridged, and opens it', async () => {
    rpc.mockImplementation((async (name: string) => (name === 'bridge_member_privacy'
      ? { data: privacy(true, false), error: null }
      : { data: null, error: null })) as never)
    mountMenu()
    await flushPromises()
    expect(entry().exists()).toBe(true)
    await entry().trigger('click')
    await flushPromises()
    expect(useBridgePrivacyStore().serverId).toBe('s1')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('hides the entry when no bridge relays the server', async () => {
    rpc.mockResolvedValue({ data: privacy(false, false), error: null } as never)
    mountMenu()
    await flushPromises()
    expect(entry().exists()).toBe(false)
  })

  it('reads nothing while closed and nothing again on a reopening', async () => {
    rpc.mockResolvedValue({ data: privacy(false, true), error: null } as never)
    mountMenu(false)
    await flushPromises()
    expect(reads()).toEqual([])
    await wrapper.setProps({ isVisible: true })
    await flushPromises()
    expect(entry().exists()).toBe(true)
    await wrapper.setProps({ isVisible: false })
    await wrapper.setProps({ isVisible: true })
    await flushPromises()
    expect(reads()).toEqual([['bridge_member_privacy', { p_server_id: 's1' }]])
  })
})
