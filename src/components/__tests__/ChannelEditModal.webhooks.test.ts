/**
 * ChannelEditModal.vue's Webhooks tab: offered for text channels to Manage Webhooks holders;
 * a holder without Manage Channels gets that tab alone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Channel } from '@/types'

const { perms } = vi.hoisted(() => ({ perms: { channels: false, webhooks: false, owner: false } }))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/composables/useServerPermissions', async () => {
  const { computed } = await import('vue')
  return {
    useServerPermissions: () => ({
      canManageChannels: computed(() => perms.channels),
      canManageWebhooks: computed(() => perms.webhooks),
      isCurrentUserServerOwner: computed(() => perms.owner),
    }),
  }
})
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ updateChannel: vi.fn() }) }))
vi.mock('@/services/userDataService', () => ({ userDataService: { getCurrentUser: () => ({ isAdmin: false }) } }))
vi.mock('@/services/RoleService', () => ({
  roleService: { getRolesForServer: vi.fn().mockResolvedValue([]), getChannelOverrides: vi.fn().mockResolvedValue([]) },
  Permission: {},
  bitmaskToPermissions: () => ({}),
}))

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, props: ['channelId', 'channel', 'canManage'], render: () => h('span', { class: name }) }) }
}
vi.mock('@/components/ChannelEncryptionSection.vue', () => stub('ChannelEncryptionSection'))
vi.mock('@/components/ChannelWebhooksSection.vue', () => stub('ChannelWebhooksSection'))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/ToggleSwitch.vue', () => stub('ToggleSwitch'))

const { default: ChannelEditModal } = await import('../ChannelEditModal.vue')

const channel = (type: number) =>
  ({ id: 'c1', server_id: 's1', name: 'ops', type, description: null }) as unknown as Channel

function mountModal(type = 0) {
  return mount(ChannelEditModal, {
    props: { show: true, channel: channel(type) },
    global: { stubs: { teleport: true } },
  })
}

const tabLabels = (wrapper: ReturnType<typeof mountModal>) => wrapper.findAll('.modal-tab').map(tab => tab.text())

beforeEach(() => {
  perms.channels = false
  perms.webhooks = false
  perms.owner = false
})

describe('ChannelEditModal webhooks tab', () => {
  it('sits beside General and Permissions for a channel manager who holds Manage Webhooks', async () => {
    perms.channels = true
    perms.webhooks = true
    const wrapper = mountModal()
    await flushPromises()
    expect(tabLabels(wrapper)).toEqual(['General', 'Permissions', 'webhooks.tab'])
  })

  it('is the only tab for a holder of Manage Webhooks alone, and opens first', async () => {
    perms.webhooks = true
    const wrapper = mountModal()
    await flushPromises()
    expect(tabLabels(wrapper)).toEqual(['webhooks.tab'])
    expect(wrapper.find('.ChannelWebhooksSection').exists()).toBe(true)
    expect(wrapper.find('.btn-primary').exists()).toBe(false)
  })

  it('is absent for a voice channel', async () => {
    perms.channels = true
    perms.webhooks = true
    const wrapper = mountModal(1)
    await flushPromises()
    expect(tabLabels(wrapper)).toEqual(['General', 'Permissions'])
  })
})
