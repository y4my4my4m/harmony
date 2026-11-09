/**
 * Admin › Configuration › Federation: "Show profiles and public posts to visitors who aren't
 * signed in" reads instance_config public_profile_pages through getInstanceConfig and saves it
 * with the other settings through setInstanceConfigs (batch_set_instance_config). The instance's
 * federation switches save through updateFederationSettings; turning both off asks first.
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
vi.mock('@/components/admin/UploadLimitsAdmin.vue', () => stub('UploadLimitsAdmin'))

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

const livekit = vi.hoisted(() => ({ fetchLiveKitConfig: vi.fn() }))
vi.mock('@/services/livekitTokens', () => livekit)

const { default: InstanceConfig } = await import('../InstanceConfig.vue')

function config(publicProfilePages: boolean, federationSwitchesLoaded = true) {
  return {
    chat: {},
    federation: { maxPostLength: 500, enableOutbound: true, enableInbound: true, federationSwitchesLoaded, publicProfilePages },
    webrtc: {},
    instance: { name: 'Harmony Test', registrationOpen: true },
  }
}

async function openFederationTab(publicProfilePages: boolean, federationSwitchesLoaded = true) {
  admin.getInstanceConfig.mockResolvedValue(config(publicProfilePages, federationSwitchesLoaded))
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

describe('federation switches', () => {
  async function turnBothOff() {
    const wrapper = await openFederationTab(true)
    await wrapper.get('[data-testid="federation-outbound-toggle"]').setValue(false)
    expect(wrapper.find('[data-testid="federation-closed-warning"]').exists()).toBe(false)
    await wrapper.get('[data-testid="federation-inbound-toggle"]').setValue(false)
    expect(wrapper.get('[data-testid="federation-closed-warning"]').text()).toContain('federation closes')
    return wrapper
  }

  it('asks before closing federation, and saves nothing when declined', async () => {
    confirm.mockResolvedValueOnce(false)
    const wrapper = await turnBothOff()
    await wrapper.get('button.save-btn').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Close federation?', dangerAction: true }))
    expect(admin.updateFederationSettings).not.toHaveBeenCalled()
    expect(admin.setInstanceConfigs).not.toHaveBeenCalled()
  })

  it('closes federation once confirmed, and asks no more while it stays closed', async () => {
    const wrapper = await turnBothOff()
    await wrapper.get('button.save-btn').trigger('click')
    await flushPromises()
    expect(admin.updateFederationSettings).toHaveBeenCalledWith(expect.objectContaining({
      inboundEnabled: false, outboundEnabled: false, federationEnabled: false,
    }))
    await wrapper.get('button.save-btn').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('saves one switch off without asking', async () => {
    const wrapper = await openFederationTab(true)
    await wrapper.get('[data-testid="federation-inbound-toggle"]').setValue(false)
    await wrapper.get('button.save-btn').trigger('click')
    await flushPromises()
    expect(confirm).not.toHaveBeenCalled()
    expect(admin.updateFederationSettings).toHaveBeenCalledWith(expect.objectContaining({
      inboundEnabled: false, outboundEnabled: true, federationEnabled: true,
    }))
  })

  it('writes no switch it did not change', async () => {
    const wrapper = await openFederationTab(true)
    await wrapper.get('[data-testid="public-profile-pages-toggle"]').setValue(false)
    await wrapper.get('button.save-btn').trigger('click')
    await flushPromises()
    expect(admin.updateFederationSettings).not.toHaveBeenCalled()
    expect(admin.setInstanceConfigs).toHaveBeenCalledTimes(1)
  })

  it('offers and writes no switch it could not read', async () => {
    const wrapper = await openFederationTab(true, false)
    expect((wrapper.get('[data-testid="federation-inbound-toggle"]').element as HTMLInputElement).disabled).toBe(true)
    await wrapper.get('button.save-btn').trigger('click')
    await flushPromises()
    expect(admin.updateFederationSettings).not.toHaveBeenCalled()
  })
})

describe('saving writes only what changed', () => {
  it('sends only the edited key, never the other switches', async () => {
    admin.getInstanceConfig.mockResolvedValue({
      chat: { maxMessageLength: 2000, allowFileUploads: false, gifClipsEnabled: true },
      federation: { maxPostLength: 500, enableOutbound: true, enableInbound: true, federationSwitchesLoaded: true, publicProfilePages: true },
      webrtc: { mode: 'sfu', livekitUrl: 'wss://lk.example', maxStageListeners: 50 },
      instance: { name: 'Harmony Test', registrationOpen: true },
    })
    const wrapper = mount(InstanceConfig, { global: { mocks: { $t: t } } })
    await flushPromises()
    expect(wrapper.get('button.save-btn').attributes('disabled')).toBeDefined()
    await wrapper.get('input[type="number"]').setValue(3000)
    await wrapper.get('button.save-btn').trigger('click')
    await flushPromises()
    expect(admin.setInstanceConfigs).toHaveBeenCalledTimes(1)
    expect((admin.setInstanceConfigs.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toEqual({ max_server_size: 3000 })
    expect(admin.updateWebRTCSettings).not.toHaveBeenCalled()
    expect(admin.updateFederationSettings).not.toHaveBeenCalled()
  })

  it('offers no save when the stored values could not be read', async () => {
    admin.getInstanceConfig.mockResolvedValue(null)
    const wrapper = mount(InstanceConfig, { global: { mocks: { $t: t } } })
    await flushPromises()
    expect(wrapper.get('button.save-btn').attributes('disabled')).toBeDefined()
    await wrapper.get('button.save-btn').trigger('click')
    await flushPromises()
    expect(admin.setInstanceConfigs).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })
})

describe('federated calls', () => {
  async function openVoiceTab(answer: unknown) {
    livekit.fetchLiveKitConfig.mockReset().mockResolvedValue(answer)
    admin.getInstanceConfig.mockResolvedValue({
      chat: {}, federation: { maxPostLength: 500, enableOutbound: true, enableInbound: true, federationSwitchesLoaded: true },
      webrtc: { mode: 'hybrid', livekitUrl: '', maxStageListeners: 50 }, instance: { name: 'Harmony Test', registrationOpen: true },
    })
    const wrapper = mount(InstanceConfig, { global: { mocks: { $t: t } } })
    await flushPromises()
    expect(livekit.fetchLiveKitConfig).not.toHaveBeenCalled()
    await wrapper.findAll('button.config-tab-btn').find((b) => b.text() === 'Voice & video')!.trigger('click')
    await flushPromises()
    return wrapper
  }
  const voice = { enabled: true, mode: 'hybrid', wsUrl: 'wss://lk.example', allowFederatedVoice: true }

  it('shows the state the backend reports, with no switch', async () => {
    const wrapper = await openVoiceTab(voice)
    const row = wrapper.get('[data-testid="webrtc-federated-state"]')
    expect(row.text()).toContain(en.admin.instance.federatedCallsOn)
    expect(row.text()).toContain('ALLOW_FEDERATED_VOICE')
    expect(row.find('input').exists()).toBe(false)
  })

  it('says off when the backend refuses them', async () => {
    const wrapper = await openVoiceTab({ ...voice, allowFederatedVoice: false })
    expect(wrapper.get('[data-testid="webrtc-federated-state"]').text()).toContain(en.admin.instance.federatedCallsOff)
  })

  it('says off when the instance has no LiveKit', async () => {
    const wrapper = await openVoiceTab({ ...voice, enabled: false, wsUrl: null })
    expect(wrapper.get('[data-testid="webrtc-federated-state"]').text()).toContain(en.admin.instance.federatedCallsNoLivekit)
  })

  it('says so when the backend does not answer', async () => {
    const wrapper = await openVoiceTab(null)
    expect(wrapper.get('[data-testid="webrtc-federated-state"]').text()).toContain(en.admin.instance.federatedCallsUnread)
  })

  it('writes no federated value when another voice setting is saved', async () => {
    const wrapper = await openVoiceTab(voice)
    await wrapper.get('select').setValue('sfu')
    await wrapper.get('button.save-btn').trigger('click')
    await flushPromises()
    expect(admin.updateWebRTCSettings).toHaveBeenCalledTimes(1)
    expect((admin.updateWebRTCSettings.mock.calls[0] as unknown as [Record<string, unknown>])[0]).not.toHaveProperty('allowFederatedVoice')
  })
})

describe('inputs before the stored values are read', () => {
  const stored = () => ({
    chat: { maxServerSize: 1111 },
    federation: { maxPostLength: 500, enableOutbound: true, enableInbound: true, federationSwitchesLoaded: true },
    webrtc: {},
    instance: { name: 'Harmony Test', registrationOpen: true },
  })
  const locked = (wrapper: ReturnType<typeof mount>) => wrapper.get('fieldset.config-section').attributes('disabled') !== undefined
  const failure = (wrapper: ReturnType<typeof mount>) => wrapper.find('[data-testid="config-load-failed"]')

  it('locks them until the load returns', async () => {
    let finish: (value: unknown) => void = () => {}
    admin.getInstanceConfig.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const wrapper = mount(InstanceConfig, { global: { mocks: { $t: t } } })
    await flushPromises()
    expect(locked(wrapper)).toBe(true)
    expect(failure(wrapper).exists()).toBe(false)
    finish(stored())
    await flushPromises()
    expect(locked(wrapper)).toBe(false)
    expect((wrapper.get('input[type="number"]').element as HTMLInputElement).value).toBe('1111')
    expect(failure(wrapper).exists()).toBe(false)
  })

  it.each([
    ['returns nothing', () => admin.getInstanceConfig.mockResolvedValue(null)],
    ['throws', () => admin.getInstanceConfig.mockRejectedValue(new Error('boom'))],
  ])('stays locked and says so when the load %s', async (_, arrange) => {
    arrange()
    const wrapper = mount(InstanceConfig, { global: { mocks: { $t: t } } })
    await flushPromises()
    expect(locked(wrapper)).toBe(true)
    expect(failure(wrapper).text()).toBe(en.admin.instance.configLoadFailed)
    expect(toast.error).toHaveBeenCalledWith(en.admin.instance.configLoadFailed)
  })

  it('leaves the upload limits tab free when the load fails', async () => {
    admin.getInstanceConfig.mockResolvedValue(null)
    const wrapper = mount(InstanceConfig, { global: { mocks: { $t: t } } })
    await flushPromises()
    await wrapper.findAll('button.config-tab-btn').find((b) => b.text() === en.uploadLimits.title)!.trigger('click')
    expect(wrapper.find('fieldset.config-section').exists()).toBe(false)
  })
})

describe('voice settings that could not be read', () => {
  it('says so and offers no voice field to edit', async () => {
    admin.getInstanceConfig.mockResolvedValue({
      chat: {}, federation: { maxPostLength: 500, enableOutbound: true, enableInbound: true, federationSwitchesLoaded: true },
      webrtc: {}, webrtcLoaded: false, instance: { name: 'Harmony Test', registrationOpen: true },
    })
    const wrapper = mount(InstanceConfig, { global: { mocks: { $t: t } } })
    await flushPromises()
    await wrapper.findAll('button.config-tab-btn').find((b) => b.text() === 'Voice & video')!.trigger('click')
    expect(wrapper.get('[data-testid="webrtc-unread"]').text()).toContain('could not be read')
    expect((wrapper.get('select').element as HTMLSelectElement).disabled).toBe(true)
    expect(admin.updateWebRTCSettings).not.toHaveBeenCalled()
  })
})
