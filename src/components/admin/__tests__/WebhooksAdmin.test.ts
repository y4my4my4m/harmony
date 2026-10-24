/**
 * Admin › Webhooks (migration 20261028600001): an admin sets the instance's webhook settings and
 * acts on any outgoing webhook; a moderator reads the settings and turns webhooks off only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import en from '@/locales/en.json'

function t(key: string, params: Record<string, unknown> = {}): string {
  const message = key.split('.').reduce<any>((node, part) => node?.[part], en)
  return typeof message === 'string' ? message.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`)) : key
}

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t }),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
const confirm = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm }) }))
const profile = vi.hoisted(() => ({ value: { is_admin: true } as { is_admin: boolean } }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ get profile() { return profile.value } }) }))
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/supabase', () => ({ supabase: { rpc } }))

const { default: WebhooksAdmin } = await import('../WebhooksAdmin.vue')

const SETTINGS = {
  outgoing_mode: 'everyone', incoming_enabled: true, rate_per_minute: 120, host_rate_per_minute: 600,
  per_user: 10, blocked_domains: ['bad.example'],
}
const ROW = {
  id: 'w1', bot_id: null, server_id: 's1', name: 'Log', url: 'https://hooks.example/x', host: 'hooks.example',
  events: ['MESSAGE_CREATE'], secret_hint: 'AbC=', is_active: true, disabled_reason: null, verified_at: '2026-10-24T00:00:00Z',
  paused: false, failing_since: null, dropped_events: 0, last_dropped_at: null, last_drop_reason: null,
  last_success_at: null, last_failure_at: null, last_status: null, last_error: null, created_at: '2026-10-24T00:00:00Z',
  bot_name: null, server_name: 'Workshop', owner_username: 'alice', deliveries_24h: 42, failed_24h: 3,
}

beforeEach(() => {
  vi.clearAllMocks()
  profile.value = { is_admin: true }
  rpc.mockImplementation(async (fn: string, args: any) => {
    switch (fn) {
      case 'admin_get_webhook_settings': return { data: SETTINGS, error: null }
      case 'admin_update_webhook_settings': return { data: { ...SETTINGS, ...args.p_settings }, error: null }
      case 'admin_list_outgoing_webhooks': return { data: [ROW], error: null }
      case 'admin_set_outgoing_webhook_active': return { data: { ...ROW, is_active: args.p_active, disabled_reason: args.p_active ? null : 'staff' }, error: null }
      case 'admin_delete_outgoing_webhook': return { data: null, error: null }
      default: throw new Error(`unexpected rpc ${fn}`)
    }
  })
})

async function mountAdmin() {
  const wrapper = mount(WebhooksAdmin, { global: { mocks: { $t: t } } })
  await flushPromises()
  return wrapper
}

describe('WebhooksAdmin', () => {
  it('lists every webhook with its owner, destination and last day', async () => {
    const wrapper = await mountAdmin()
    const row = wrapper.get('[data-testid="webhooks-admin-w1"]')
    expect(row.text()).toContain('Server Workshop')
    expect(row.text()).toContain('@alice')
    expect(row.text()).toContain('hooks.example')
    expect(row.text()).toContain('42 sent, 3 failed')
  })

  it('saves the settings, one blocked domain per line', async () => {
    const wrapper = await mountAdmin()
    await wrapper.get('[data-testid="webhooks-outgoing-mode"]').setValue('staff')
    await wrapper.get('[data-testid="webhooks-rate"]').setValue(30)
    await wrapper.get('[data-testid="webhooks-blocked-domains"]').setValue('bad.example\nworse.example ')
    await wrapper.get('[data-testid="webhooks-save"]').trigger('submit')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('admin_update_webhook_settings', { p_settings: expect.objectContaining({
      outgoing_mode: 'staff', rate_per_minute: 30, blocked_domains: ['bad.example', 'worse.example'],
    }) })
    expect(toast.success).toHaveBeenCalledWith('Webhook settings saved')
  })

  it('turns a webhook off as staff, and deletes one after asking', async () => {
    const wrapper = await mountAdmin()
    await wrapper.get('[data-testid="webhooks-admin-toggle-w1"]').trigger('click')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('admin_set_outgoing_webhook_active', { p_webhook_id: 'w1', p_active: false })
    expect(wrapper.get('[data-testid="webhooks-admin-w1"]').text()).toContain('Off (staff)')

    await wrapper.get('[data-testid="webhooks-admin-delete-w1"]').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete this webhook?', dangerAction: true }))
    expect(wrapper.find('[data-testid="webhooks-admin-w1"]').exists()).toBe(false)
  })

  it('leaves a moderator the settings read-only and no delete', async () => {
    profile.value = { is_admin: false }
    const wrapper = await mountAdmin()
    expect((wrapper.get('[data-testid="webhooks-outgoing-mode"]').element as HTMLSelectElement).disabled).toBe(true)
    expect(wrapper.find('[data-testid="webhooks-save"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="webhooks-admin-delete-w1"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="webhooks-admin-toggle-w1"]').exists()).toBe(true)
  })
})
