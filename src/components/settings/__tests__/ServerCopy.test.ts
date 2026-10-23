// A copy of a server hosted on another instance names its host and its host owner, and says that
// settings here change only this instance's view, except above the instance staff's tools. Its
// emojis carry no view-only notice: the banner says who manages them.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { useI18n } from 'vue-i18n'
import ServerCopyBanner from '../server/ServerCopyBanner.vue'
import ServerBasicInfo from '../ServerBasicInfo.vue'
import ServerEmojiManagement from '../ServerEmojiManagement.vue'

vi.mock('vue-i18n', async (importOriginal) => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params?: Record<string, unknown> | string) => {
    const message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return typeof params === 'string' ? params : key
    const values = typeof params === 'object' ? params : {}
    return message.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`))
  }
  return { ...(await importOriginal<typeof import('vue-i18n')>()), useI18n: () => ({ t, locale: { value: 'en' } }) }
})

vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => ({ showToast: vi.fn() }) }))
vi.mock('@/composables/useImageCrop', () => ({ useImageCrop: () => ({ cropImage: vi.fn() }) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }) }))
vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/services/emojiService', () => ({ uploadEmoji: vi.fn(), deleteEmoji: vi.fn(), renameEmoji: vi.fn(), bulkDeleteEmojis: vi.fn() }))
vi.mock('@/stores/useInstanceSettings', () => ({ useInstanceSettingsStore: () => ({ settings: { maxCustomEmojisPerServer: 50 } }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: { id: 'me' } }) }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }) }))
vi.mock('@/components/common/ServerIcon.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'ServerIcon', setup: () => () => h('img') }) }
})

enableAutoUnmount(afterEach)

const copy = { is_local_server: false, federation_domain: 'host.test' }

describe('ServerCopyBanner', () => {
  it('names the host and what settings here change', () => {
    const wrapper = mount(ServerCopyBanner, { props: { server: copy as any } })
    const banner = wrapper.get('[data-testid="server-copy-banner"]')
    expect(banner.text()).toContain('Hosted on host.test')
    expect(banner.text()).toContain('Its owner and moderators manage it there. Settings here only change what you see.')
    expect(banner.attributes('role')).toBe('note')
  })

  it('above the instance staff\'s tools, does not say settings only change what you see', () => {
    const wrapper = mount(ServerCopyBanner, { props: { server: copy as any, instanceTools: true } })
    expect(wrapper.text()).toContain('Hosted on host.test')
    expect(wrapper.get('[data-testid="server-copy-banner-body"]').text()).toBe('Its owner and moderators manage it there.')
  })

  it('says another instance when the copy names no host', () => {
    const wrapper = mount(ServerCopyBanner, { props: { server: { is_local_server: false } as any } })
    expect(wrapper.text()).toContain('Hosted on another instance')
  })

  it('is absent on a server hosted here', () => {
    const wrapper = mount(ServerCopyBanner, { props: { server: { is_local_server: true } as any } })
    expect(wrapper.find('[data-testid="server-copy-banner"]').exists()).toBe(false)
  })
})

describe('ServerBasicInfo on a copy', () => {
  const permissions = {
    canEditBasicInfo: false, canChangeServerName: false, canChangeServerDescription: false,
    canChangeServerIcon: false, canChangePrivacySettings: false,
  }
  const mountInfo = (copyOwner: { displayName: string; handle: string | null } | null) => {
    const { t } = useI18n()
    return mount(ServerBasicInfo, {
      props: {
        server: { id: 's1', name: 'Harbour', description: '', icon: null, rules: [], is_local_server: false } as any,
        selectedFile: null,
        ownerName: 'local-admin',
        isCopy: true,
        copyOwner,
        loading: false,
        permissions,
      },
      global: { mocks: { $t: t } },
    })
  }

  it('names the host owner by display name and handle, never a local admin', () => {
    const wrapper = mountInfo({ displayName: 'Alice', handle: '@alice@host.test' })
    const row = wrapper.get('[data-testid="server-copy-owner"]')
    expect(row.text()).toContain('Owner')
    expect(row.text()).toContain('Alice')
    expect(row.text()).toContain('@alice@host.test')
    expect(wrapper.text()).not.toContain('local-admin')
    expect(wrapper.text()).not.toContain('full administrative privileges')
    expect(wrapper.text()).not.toContain('View only access')
  })

  it('says Unknown while the copy has no owner', () => {
    const row = mountInfo(null).get('[data-testid="server-copy-owner"]')
    expect(row.text()).toContain('Unknown')
  })
})

describe('ServerEmojiManagement on a copy', () => {
  const mountEmojis = (isCopy: boolean) => {
    const { t } = useI18n()
    return mount(ServerEmojiManagement, {
      props: {
        emojis: [], allowCrossServer: false, serverId: 's1', ownerId: 'host-owner', loading: false, isCopy,
        permissions: { canUpload: false, canDelete: false, canRename: false, canManageCrossServer: false },
      },
      global: { mocks: { $t: t } },
    })
  }

  it('shows no notice naming the server owner and emoji managers', () => {
    const wrapper = mountEmojis(true)
    expect(wrapper.find('[data-testid="emoji-view-only"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Only the server owner')
  })

  it('keeps the notice on a server hosted here', () => {
    expect(mountEmojis(false).find('[data-testid="emoji-view-only"]').exists()).toBe(true)
  })
})
