/**
 * Admin › Configuration › Federation: "Show profiles and public posts to visitors who aren't
 * signed in" reads instance_config public_profile_pages through getInstanceConfig and saves it
 * with the other settings through setInstanceConfigs (batch_set_instance_config).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import en from '@/locales/en.json'

function t(key: string): string {
  const message = key.split('.').reduce<any>((node, part) => node?.[part], en)
  return typeof message === 'string' ? message : key
}

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/ColorPicker.vue', () => stub('ColorPicker'))
vi.mock('@/components/admin/NewcomerAlertsDefault.vue', () => stub('NewcomerAlertsDefault'))
vi.mock('@/components/settings/discord-bridge/BridgeAdminSection.vue', () => stub('BridgeAdminSection'))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'admin-auth-id' } } }) }))
const fetchSettings = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/stores/useInstanceSettings', () => ({ useInstanceSettingsStore: () => ({ fetchSettings }) }))
vi.mock('@/services/TrendingService', () => ({ trendingService: { updateTrendingScores: vi.fn() } }))

const admin = vi.hoisted(() => ({
  getInstanceConfig: vi.fn(),
  updateFederationSettings: vi.fn(async () => true),
  setInstanceConfigs: vi.fn(async () => {}),
  updateWebRTCSettings: vi.fn(async () => true),
}))
vi.mock('@/services/AdminService', () => ({ adminService: admin }))

const { default: InstanceConfig } = await import('../InstanceConfig.vue')

function config(publicProfilePages: boolean) {
  return {
    chat: {},
    federation: { maxPostLength: 500, enableOutbound: true, enableInbound: true, publicProfilePages },
    webrtc: {},
    instance: { name: 'Harmony Test', registrationOpen: true },
  }
}

async function openFederationTab(publicProfilePages: boolean) {
  admin.getInstanceConfig.mockResolvedValue(config(publicProfilePages))
  const wrapper = mount(InstanceConfig, { global: { mocks: { $t: t } } })
  await flushPromises()
  const tab = wrapper.findAll('button.config-tab-btn').find((b) => b.text() === 'Federation')
  await tab!.trigger('click')
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('public profile pages setting', () => {
  it('shows the toggle with its label and hint, as stored', async () => {
    const wrapper = await openFederationTab(false)
    const toggle = wrapper.get('[data-testid="public-profile-pages-toggle"]')
    expect((toggle.element as HTMLInputElement).checked).toBe(false)
    const label = toggle.element.closest('label')!
    expect(label.textContent).toContain("Show profiles and public posts to visitors who aren't signed in")
    const hint = wrapper.get('#public-profile-pages-hint')
    expect(toggle.attributes('aria-describedby')).toBe('public-profile-pages-hint')
    expect(hint.text()).toBe('When off, visitors are sent to sign in. Link previews and federation are unaffected.')
  })

  it('reads on when stored on', async () => {
    const wrapper = await openFederationTab(true)
    expect((wrapper.get('[data-testid="public-profile-pages-toggle"]').element as HTMLInputElement).checked).toBe(true)
  })

  it('saves public_profile_pages with the other settings', async () => {
    const wrapper = await openFederationTab(true)
    await wrapper.get('[data-testid="public-profile-pages-toggle"]').setValue(false)
    await wrapper.get('button.save-btn').trigger('click')
    await flushPromises()
    expect(admin.setInstanceConfigs).toHaveBeenCalledTimes(1)
    const [values, adminId] = admin.setInstanceConfigs.mock.calls[0] as unknown as [Record<string, unknown>, string]
    expect(values.public_profile_pages).toBe(false)
    expect(adminId).toBe('admin-auth-id')
    expect(fetchSettings).toHaveBeenCalledWith(true)

    await wrapper.get('[data-testid="public-profile-pages-toggle"]').setValue(true)
    await wrapper.get('button.save-btn').trigger('click')
    await flushPromises()
    expect((admin.setInstanceConfigs.mock.calls[1] as unknown as [Record<string, unknown>])[0].public_profile_pages).toBe(true)
  })
})
