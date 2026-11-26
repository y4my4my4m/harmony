/**
 * Server settings keep unsaved encryption edits across a section switch: they still enable
 * Save, still save from another section and report a save that failed there.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

const SERVER_ID = 'server-1'
const SERVER = { id: SERVER_ID, name: 'Test', description: '', icon: '', owner: 'owner-1', rules: [], public: false }

const { saveSettings, toast, stub } = vi.hoisted(() => ({
  // Returns whether the save went through, as ServerEncryptionSettings clears its changes then.
  saveSettings: vi.fn(() => true),
  toast: { success: vi.fn(), error: vi.fn() },
  stub: (name: string) => ({ default: { name, render: () => null } }),
}))

vi.mock('@/components/settings/ServerEncryptionSettings.vue', async () => {
  const { defineComponent, h, ref } = await import('vue')
  return {
    default: defineComponent({
      setup(_props, { expose }) {
        const hasChanges = ref(false)
        expose({ hasChanges, saveSettings: async () => { if (saveSettings()) hasChanges.value = false } })
        return () => h('button', { class: 'encryption-edit', onClick: () => { hasChanges.value = true } })
      },
    }),
  }
})

vi.mock('@/components/settings/ServerBasicInfo.vue', () => stub('ServerBasicInfo'))
vi.mock('@/components/settings/server/InstanceServerPanel.vue', () => stub('InstanceServerPanel'))
vi.mock('@/components/settings/ServerEmojiManagement.vue', () => stub('ServerEmojiManagement'))
vi.mock('@/components/settings/ServerPrivacySettings.vue', () => stub('ServerPrivacySettings'))
vi.mock('@/components/OutgoingWebhooksPanel.vue', () => stub('OutgoingWebhooksPanel'))
vi.mock('@/components/settings/ServerAdvancedSettings.vue', () => stub('ServerAdvancedSettings'))
vi.mock('@/components/settings/ServerBotsSettings.vue', () => stub('ServerBotsSettings'))
vi.mock('@/components/settings/bridges/BridgesSettings.vue', () => stub('BridgesSettings'))
vi.mock('@/components/settings/RoleManagement.vue', () => stub('RoleManagement'))
vi.mock('@/components/settings/server/ServerBans.vue', () => stub('ServerBans'))
vi.mock('@/components/settings/server/ServerNewcomerAlerts.vue', () => stub('ServerNewcomerAlerts'))
vi.mock('@/components/settings/server/ServerSystemMessages.vue', () => stub('ServerSystemMessages'))
vi.mock('@/components/settings/server/ServerJoinRole.vue', () => stub('ServerJoinRole'))
vi.mock('@/components/settings/server/ServerAutoMod.vue', () => stub('ServerAutoMod'))
vi.mock('@/components/settings/server/AutoModOptInBanner.vue', () => stub('AutoModOptInBanner'))
vi.mock('@/components/settings/server/ServerWelcomeSettings.vue', () => stub('ServerWelcomeSettings'))
vi.mock('@/components/settings/server/ServerAuditLog.vue', () => stub('ServerAuditLog'))
vi.mock('@/components/settings/server/ServerSoundboardManagement.vue', () => stub('ServerSoundboardManagement'))
vi.mock('@/components/stickers/StickerSettings.vue', () => stub('StickerSettings'))
vi.mock('@/components/settings/server/ServerTemplateExport.vue', () => stub('ServerTemplateExport'))
vi.mock('@/components/settings/server/ServerCopyBanner.vue', () => stub('ServerCopyBanner'))
vi.mock('@/components/admin/ReportsModeration.vue', () => stub('ReportsModeration'))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/stores/server', () => ({
  useServerStore: () => ({ getServer: async () => ({ ...SERVER }), updateServer: async () => true }),
}))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ servers: [SERVER] }) }))
vi.mock('@/stores/useEmojiCache', () => ({
  useEmojiCacheStore: () => ({ getServerEmojis: () => [], loadEmojisForServers: async () => {}, invalidate: () => {} }),
}))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: null }) }))
vi.mock('@/stores/useInstanceSettings', () => ({
  useInstanceSettingsStore: () => ({ fetchSettings: async () => {}, isLoaded: true, settings: { maxStickersPerServer: 10 } }),
}))
vi.mock('@/stores/useStickers', () => ({ useStickersStore: () => ({ serverStickers: async () => [] }) }))
vi.mock('@/composables/useServerPermissions', async () => {
  const { ref } = await import('vue')
  // Every can* permission granted; Vue's own __v_ flags stay unset.
  const all = new Proxy({}, { get: (_t, key) => typeof key === 'string' && key.startsWith('can') })
  return { useServerPermissions: () => ({ serverSettingsPermissions: ref(all) }) }
})
vi.mock('@/composables/useReportQueueCounts', () => ({
  badgeCount: (n: number) => String(n),
  refreshServerPendingReports: async () => {},
  useReportQueueCounts: () => ({ serverPending: new Map() }),
}))
vi.mock('@/composables/useLayoutState', async () => {
  const { ref } = await import('vue')
  return { useLayoutState: () => ({ isMobile: ref(false) }) }
})
vi.mock('@/composables/useDrawer', () => ({ useDrawer: () => ({ toggleAttrs: {} }) }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: async () => true }) }))
vi.mock('@/composables/useOpenServer', () => ({ useOpenServer: () => () => {} }))
vi.mock('@/composables/useUnsavedLeaveGuard', () => ({ useUnsavedLeaveGuard: () => ({ confirmLeave: async () => true }) }))
vi.mock('@/composables/useLeaveServer', () => ({ useLeaveServer: () => ({ leaveServer: async () => {} }) }))
vi.mock('@/services/ProfileService', () => ({ getProfileWithAvatarUrl: async () => null }))
vi.mock('@/services/AutoModService', () => ({ getServerAutoMod: async () => ({ status: 'enabled' }) }))
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: () => false }))

import ServerSettings from '../ServerSettings.vue'

const i18n = createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: {} } })

async function openPrivacyAndEdit() {
  const wrapper = mount(ServerSettings, { props: { serverId: SERVER_ID }, global: { plugins: [i18n] } })
  await flushPromises()
  const nav = (label: string) => wrapper.findAll('.nav-item').find((b) => b.text() === label)!
  await nav('server.privacySettings').trigger('click')
  await flushPromises()
  await wrapper.find('.encryption-edit').trigger('click')
  await nav('server.overview').trigger('click')
  await flushPromises()
  return wrapper
}
const saveButton = (wrapper: Awaited<ReturnType<typeof openPrivacyAndEdit>>) =>
  wrapper.find('.server-settings-actions .btn-primary')

describe('ServerSettings encryption edits', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keep Save enabled after switching to another section', async () => {
    const wrapper = await openPrivacyAndEdit()
    expect(wrapper.find('.encryption-edit').exists()).toBe(false)
    expect(saveButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('save from another section', async () => {
    const wrapper = await openPrivacyAndEdit()
    await saveButton(wrapper).trigger('click')
    await flushPromises()
    expect(saveSettings).toHaveBeenCalledOnce()
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined()
    expect(toast.success).toHaveBeenCalledOnce()
  })

  it('report a save that failed in another section', async () => {
    const wrapper = await openPrivacyAndEdit()
    saveSettings.mockReturnValueOnce(false)
    await saveButton(wrapper).trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledOnce()
    expect(toast.success).not.toHaveBeenCalled()
    expect(saveButton(wrapper).attributes('disabled')).toBeUndefined()
  })
})
