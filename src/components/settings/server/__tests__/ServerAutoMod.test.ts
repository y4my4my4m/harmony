/**
 * ServerAutoMod.vue: the opt-in card for an unconfigured server, the rule list of a
 * configured one, and that every change goes through the AutoMod RPCs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { supabase } from '@/supabase'
import ServerAutoMod from '../ServerAutoMod.vue'

const { toast, confirmMock, api } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  confirmMock: vi.fn(),
  api: {
    getServerAutoMod: vi.fn(),
    enableAutoModPreset: vi.fn(),
    updateAutoModSettings: vi.fn(),
    saveAutoModRule: vi.fn(),
    deleteAutoModRule: vi.fn(),
    getAutoModEvents: vi.fn(),
    getMemberTimeouts: vi.fn(),
    setMemberTimeout: vi.fn(),
    setRaidLockdown: vi.fn(),
  },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: confirmMock }) }))
vi.mock('@/services/RoleService', () => ({
  roleService: {
    getServerRoles: vi.fn().mockResolvedValue([
      { id: 'role-everyone', name: 'everyone', color: '#999', is_default: true },
      { id: 'role-trusted', name: 'trusted', color: '#0f0', is_default: false },
    ]),
  },
}))
vi.mock('@/services/AutoModService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/AutoModService')>()
  return { ...actual, ...api }
})

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/common/LoadingSpinner.vue', () => stub('LoadingSpinner'))

const SERVER_ID = 'server-1'

function channelsQuery(rows: any[]) {
  const q: any = {
    select: () => q,
    eq: () => q,
    order: () => Promise.resolve({ data: rows, error: null }),
  }
  return q
}

const CONFIGURED = {
  status: 'enabled',
  settings: {
    enabled: true,
    alert_channel_id: null,
    exempt_bots: true,
    raid_settings: { enabled: true, join_threshold: 10, window_seconds: 60, action: 'alert', slowmode_seconds: 30 },
    raid_state: { active: false },
    last_raid_at: null,
    prompt_dismissed_at: null,
    updated_at: null,
  },
  rules: [
    {
      id: 'rule-1',
      name: 'Block mention spam',
      rule_type: 'mention_spam',
      enabled: true,
      config: { max_mentions: 20, window_mentions: 50, window_seconds: 60, block_everyone_without_permission: false },
      actions: { block: true, alert: true, timeout_seconds: 0, block_message: null },
      exempt_role_ids: [],
      exempt_channel_ids: [],
      position: 0,
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(supabase.from as any).mockImplementation((table: string) =>
    channelsQuery(table === 'channels' ? [{ id: 'ch-1', name: 'general', type: 0, category: null }] : []),
  )
  api.getAutoModEvents.mockResolvedValue([])
  api.getMemberTimeouts.mockResolvedValue([])
})

describe('ServerAutoMod', () => {
  it('offers the recommended preset on an unconfigured server and enables it on request', async () => {
    api.getServerAutoMod.mockResolvedValue({ status: 'unconfigured', settings: null, rules: [] })
    api.enableAutoModPreset.mockResolvedValue(CONFIGURED)

    const wrapper = mount(ServerAutoMod, { props: { serverId: SERVER_ID } })
    await flushPromises()

    expect(wrapper.text()).toContain('automod.setup.title')
    expect(api.updateAutoModSettings).not.toHaveBeenCalled()

    await wrapper.find('.setup-actions .btn-primary').trigger('click')
    await flushPromises()

    expect(api.enableAutoModPreset).toHaveBeenCalledWith(SERVER_ID)
    expect(wrapper.emitted('status-change')?.at(-1)).toEqual(['enabled'])
    expect(wrapper.text()).toContain('Block mention spam')
  })

  it('lists rules and sends the alert channel through update_server_automod_settings', async () => {
    api.getServerAutoMod.mockResolvedValue(CONFIGURED)
    api.updateAutoModSettings.mockResolvedValue({
      ...CONFIGURED,
      settings: { ...CONFIGURED.settings, alert_channel_id: 'ch-1' },
    })

    const wrapper = mount(ServerAutoMod, { props: { serverId: SERVER_ID } })
    await flushPromises()

    expect(wrapper.findAll('.rule-card')).toHaveLength(1)
    await wrapper.find('select.select-input').setValue('ch-1')
    await flushPromises()

    expect(api.updateAutoModSettings).toHaveBeenCalledWith(SERVER_ID, { alert_channel_id: 'ch-1' })
  })

  it('shows a load error instead of controls when the RPC refuses', async () => {
    api.getServerAutoMod.mockRejectedValue(new Error('Missing permission: MANAGE_SERVER'))

    const wrapper = mount(ServerAutoMod, { props: { serverId: SERVER_ID } })
    await flushPromises()

    expect(wrapper.find('[role="alert"]').text()).toContain('Missing permission')
    expect(wrapper.find('.rule-card').exists()).toBe(false)
  })
})
