/**
 * The invite dialog says who the link admits: accounts on other instances when federation is on
 * for the server and the instance, only this instance's accounts when either has it off, and
 * nothing for a server another instance hosts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

const { stores, t } = vi.hoisted(() => ({
  stores: {
    servers: [] as Array<{ id: string; federation_enabled?: boolean; is_local_server?: boolean }>,
    instance: { isFederationEnabled: true },
  },
  // A key and its parameters, so a test reads which message and which values were shown.
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ')}` : key,
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t, locale: ref('en') }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/supabase', () => ({ supabase: { rpc: vi.fn(async () => ({ data: [], error: null })) } }))
vi.mock('@/composables/useServerInvites', async () => {
  const { ref } = await import('vue')
  return {
    useServerInvites: () => ({
      canCreate: ref(false),
      create: vi.fn(),
      creating: ref(false),
      current: ref(null),
      currentUrl: ref('https://harmony.test/invite/ABCD1234'),
      expiresIn: ref(0),
      expiryChoices: [],
      loading: ref(false),
      maxUseChoices: [],
      maxUses: ref(0),
      open: vi.fn(async () => {}),
      otherInvites: ref([]),
      revoke: vi.fn(),
      show: vi.fn(),
    }),
  }
})
vi.mock('@/composables/useVisualTheme', async () => {
  const { ref } = await import('vue')
  return { useVisualTheme: () => ({ settings: ref({}) }) }
})
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ servers: stores.servers }) }))
vi.mock('@/stores/useInstanceSettings', () => ({ useInstanceSettingsStore: () => stores.instance }))
vi.mock('@/services/instanceConfig', () => ({ getInstanceDomain: () => 'harmony.test' }))
vi.mock('@/components/common/BaseModal.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'BaseModal', setup: (_props, { slots }) => () => h('div', slots.default?.()) }) }
})

import InviteModal from '../InviteModal.vue'

enableAutoUnmount(afterEach)

const SERVER_ID = 'srv-1'

async function note() {
  const wrapper = mount(InviteModal, {
    props: { show: true, serverId: SERVER_ID, serverData: { id: SERVER_ID, name: 'Hall' } },
    global: { stubs: { Icon: true } },
  })
  await flushPromises()
  const el = wrapper.find('[data-testid="invite-federation"]')
  return el.exists() ? el.text() : null
}

beforeEach(() => {
  stores.servers.length = 0
  stores.instance.isFederationEnabled = true
})

describe('InviteModal federation note', () => {
  it('says accounts on other instances can join when the server and the instance federate', async () => {
    stores.servers.push({ id: SERVER_ID, federation_enabled: true, is_local_server: true })
    expect(await note()).toBe('invite.modal.federationOn')
  })

  it('names this instance only when the server has federation off', async () => {
    stores.servers.push({ id: SERVER_ID, federation_enabled: false, is_local_server: true })
    expect(await note()).toBe('invite.modal.federationOff instance=harmony.test')
  })

  it('says federation is off for the instance when the instance has it off, whatever the server says', async () => {
    stores.instance.isFederationEnabled = false
    stores.servers.push({ id: SERVER_ID, federation_enabled: true, is_local_server: true })
    expect(await note()).toBe('invite.modal.federationOffInstance instance=harmony.test')
  })

  it('says nothing for a server another instance hosts', async () => {
    stores.instance.isFederationEnabled = false
    stores.servers.push({ id: SERVER_ID, federation_enabled: true, is_local_server: false })
    expect(await note()).toBeNull()
  })
})
