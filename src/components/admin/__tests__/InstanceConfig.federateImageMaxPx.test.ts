/**
 * Admin › Configuration › Federation: the largest photo side sent to other servers
 * (instance_config federate_image_max_px) loads through getInstanceConfig and is written,
 * alone, only when it changes.
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

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t }),
}))
const confirm = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm }) }))

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

async function openFederationTab(federation: Record<string, unknown>) {
  admin.getInstanceConfig.mockResolvedValue({
    chat: {},
    federation: { maxPostLength: 500, enableOutbound: true, enableInbound: true, federationSwitchesLoaded: true, ...federation },
    webrtc: {},
    instance: { name: 'Harmony Test', registrationOpen: true },
  })
  const wrapper = mount(InstanceConfig, { global: { mocks: { $t: t } } })
  await flushPromises()
  const tab = wrapper.findAll('button.config-tab-btn').find((b) => b.text() === 'Federation')
  await tab!.trigger('click')
  return wrapper
}

const input = (wrapper: Awaited<ReturnType<typeof openFederationTab>>) =>
  wrapper.get('[data-testid="federate-image-max-px-input"]')

async function save(wrapper: Awaited<ReturnType<typeof openFederationTab>>) {
  await wrapper.get('button.save-btn').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('federated photo size setting', () => {
  it('shows the stored size with its label and hint', async () => {
    const wrapper = await openFederationTab({ federateImageMaxPx: 1280 })
    expect((input(wrapper).element as HTMLInputElement).value).toBe('1280')
    expect(wrapper.get('label[for="federate-image-max-px"]').text()).toBe('Largest photo side sent to other servers (px)')
    expect(input(wrapper).attributes('aria-describedby')).toBe('federate-image-max-px-hint')
    expect(wrapper.get('#federate-image-max-px-hint').text()).toContain('0 sends originals')
  })

  it('is not written while unchanged', async () => {
    const wrapper = await openFederationTab({ federateImageMaxPx: 1920 })
    expect(wrapper.get('button.save-btn').attributes('disabled')).toBeDefined()
  })

  it('writes only the changed size, clamped to the render limit', async () => {
    const wrapper = await openFederationTab({ federateImageMaxPx: 1920 })
    await input(wrapper).setValue('0')
    await save(wrapper)
    expect(admin.setInstanceConfigs).toHaveBeenCalledWith({ federate_image_max_px: 0 }, 'admin-auth-id')

    await input(wrapper).setValue('5000')
    await save(wrapper)
    expect(admin.setInstanceConfigs).toHaveBeenLastCalledWith({ federate_image_max_px: 2000 }, 'admin-auth-id')
  })

  it('reads an emptied field as the default', async () => {
    const wrapper = await openFederationTab({ federateImageMaxPx: 1024 })
    await input(wrapper).setValue('')
    await save(wrapper)
    expect(admin.setInstanceConfigs).toHaveBeenCalledWith({ federate_image_max_px: 1920 }, 'admin-auth-id')
  })
})
