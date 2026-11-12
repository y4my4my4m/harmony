/**
 * Admin > Configuration > General > Bridge attachments: with "Mirror to storage" selected, the
 * hint shows how far the background queue that stores Discord files has got, read through
 * bridge_mirror_status(). Other modes never call it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import en from '@/locales/en.json'

function t(key: string, params: Record<string, unknown> = {}): string {
  const message = key.split('.').reduce<any>((node, part) => node?.[part], en)
  if (typeof message !== 'string') return key
  return message.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
}

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/ColorPicker.vue', () => stub('ColorPicker'))
vi.mock('@/components/admin/NewcomerAlertsDefault.vue', () => stub('NewcomerAlertsDefault'))
vi.mock('@/components/settings/discord-bridge/BridgeAdminSection.vue', () => stub('BridgeAdminSection'))
vi.mock('@/components/admin/UploadLimitsAdmin.vue', () => stub('UploadLimitsAdmin'))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t }),
}))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'admin-auth-id' } } }) }))
vi.mock('@/stores/useInstanceSettings', () => ({ useInstanceSettingsStore: () => ({ fetchSettings: vi.fn() }) }))
vi.mock('@/services/TrendingService', () => ({ trendingService: { updateTrendingScores: vi.fn() } }))

const admin = vi.hoisted(() => ({
  getInstanceConfig: vi.fn(),
  updateFederationSettings: vi.fn(async () => true),
  setInstanceConfigs: vi.fn(async () => {}),
  updateWebRTCSettings: vi.fn(async () => true),
}))
vi.mock('@/services/AdminService', () => ({ adminService: admin }))
vi.mock('@/services/livekitTokens', () => ({ fetchLiveKitConfig: vi.fn() }))

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/supabase', () => ({
  supabase: { rpc, storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: '' } }) }) } },
}))

const { default: InstanceConfig } = await import('../InstanceConfig.vue')

function status(over: Record<string, number> = {}) {
  return { queued: 12, done: 300, too_large: 2, too_large_bytes: 1200000000, failed: 1, ...over }
}

async function open(mode: string) {
  admin.getInstanceConfig.mockResolvedValue({
    chat: { bridgeAttachmentMode: mode },
    federation: { federationSwitchesLoaded: true },
    webrtc: {},
    instance: { name: 'Harmony Test', registrationOpen: true },
  })
  const wrapper = mount(InstanceConfig, { global: { mocks: { $t: t } } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  rpc.mockResolvedValue({ data: status(), error: null })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Discord file storage progress', () => {
  it('shows the counts in mirror mode', async () => {
    const wrapper = await open('mirror')
    expect(rpc).toHaveBeenCalledWith('bridge_mirror_status')
    const text = wrapper.get('[data-testid="mirror-status"]').text()
    expect(text).toContain('Storing Discord files: 12 waiting, 300 stored')
    expect(text).toContain('2 too large (1.2 GB): raise the upload ceiling with harmony config --upload-ceiling 500M')
    expect(text).toContain('1 failed')
  })

  it('says every file is stored when nothing is left over', async () => {
    rpc.mockResolvedValue({ data: status({ queued: 0, too_large: 0, too_large_bytes: 0, failed: 0 }), error: null })
    const wrapper = await open('mirror')
    expect(wrapper.get('[data-testid="mirror-status"]').text()).toContain('Every Discord file is stored')
  })

  it('names the files held back by the limit per server, and does not call everything stored then', async () => {
    rpc.mockResolvedValue({ data: { ...status({ queued: 0, too_large: 0, too_large_bytes: 0, failed: 0 }), over_quota: 4 }, error: null })
    const wrapper = await open('mirror')
    const text = wrapper.get('[data-testid="mirror-status"]').text()
    expect(text).toContain('4 over the limit per server: raise Stored Discord files per server')
    expect(text).not.toContain('Every Discord file is stored')
  })

  it('does not call the status RPC in link mode', async () => {
    const wrapper = await open('link')
    expect(rpc).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="mirror-status"]').exists()).toBe(false)
  })

  it('shows no status when the RPC fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'nope' } })
    const wrapper = await open('mirror')
    expect(wrapper.find('[data-testid="mirror-status"]').exists()).toBe(false)
  })

  it('refreshes every 30 seconds and stops after unmount', async () => {
    vi.useFakeTimers()
    const wrapper = await open('mirror')
    expect(rpc).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(rpc).toHaveBeenCalledTimes(2)
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rpc).toHaveBeenCalledTimes(2)
  })
})
