/**
 * AdminPanel.vue Emojis tab: the local library and the browse list show rows of the same table.
 * A change in one reloads the other, and an import from the remote importer reloads both, so
 * neither acts on a row the other has renamed or deleted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

const calls = vi.hoisted(() => ({ libraryRefresh: vi.fn(async () => {}), browseLoad: vi.fn(async () => {}) }))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(async () => {}) }),
  useRoute: () => ({ query: { tab: 'emojis' } }),
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'admin' } } }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: { is_admin: true } }) }))
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: () => true }))
vi.mock('@/composables/useLayoutState', async () => {
  const { ref } = await import('vue')
  return { useLayoutState: () => ({ isMobile: ref(false), openLeftSidebar: vi.fn() }) }
})
vi.mock('@/services/AdminService', () => ({
  adminService: {
    checkAdminOrModPermissions: vi.fn(async () => true),
    getSystemStats: vi.fn(async () => ({})),
    getSystemHealth: vi.fn(async () => ({
      database: { responseTime: 0, connections: 0 },
      federation: { pending: 0, status: 'ok' },
      storage: { used: 0, total: '0' },
    })),
  },
}))

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/admin/ActivityLog.vue', () => stub('ActivityLog'))

vi.mock('@/components/admin/InstanceEmojiLibrary.vue', async () => {
  const { defineComponent, h } = await import('vue')
  // __esModule: defineAsyncComponent takes `default` only from a module it recognises.
  return {
    __esModule: true,
    default: defineComponent({
      name: 'InstanceEmojiLibrary',
      emits: ['changed'],
      setup(_, { expose }) {
        expose({ refresh: calls.libraryRefresh })
        return () => h('div', { class: 'library-stub' })
      },
    }),
  }
})
vi.mock('@/components/admin/InstanceEmojiAdmin.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    __esModule: true,
    default: defineComponent({
      name: 'InstanceEmojiAdmin',
      emits: ['changed'],
      setup(_, { expose }) {
        expose({ load: calls.browseLoad })
        return () => h('div', { class: 'browse-stub' })
      },
    }),
  }
})
vi.mock('@/components/admin/EmojiImporter.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { __esModule: true, default: defineComponent({ name: 'EmojiImporter', emits: ['imported'], render: () => h('div') }) }
})

import AdminPanel from '../AdminPanel.vue'

enableAutoUnmount(afterEach)

beforeEach(() => {
  calls.libraryRefresh.mockClear()
  calls.browseLoad.mockClear()
})

async function emojisTab() {
  const w = mount(AdminPanel, { global: { mocks: { $t: (key: string) => key } } })
  await flushPromises()
  await vi.dynamicImportSettled()
  await flushPromises()
  return w
}

describe('AdminPanel emoji lists', () => {
  it('reloads the browse list when the library changes', async () => {
    const w = await emojisTab()
    w.findComponent({ name: 'InstanceEmojiLibrary' }).vm.$emit('changed')
    expect(calls.browseLoad).toHaveBeenCalledTimes(1)
    expect(calls.libraryRefresh).not.toHaveBeenCalled()
  })

  it('refreshes the library when the browse list changes', async () => {
    const w = await emojisTab()
    w.findComponent({ name: 'InstanceEmojiAdmin' }).vm.$emit('changed')
    expect(calls.libraryRefresh).toHaveBeenCalledTimes(1)
    expect(calls.browseLoad).not.toHaveBeenCalled()
  })

  it('reloads both after an import', async () => {
    const w = await emojisTab()
    w.findComponent({ name: 'EmojiImporter' }).vm.$emit('imported')
    expect(calls.libraryRefresh).toHaveBeenCalledTimes(1)
    expect(calls.browseLoad).toHaveBeenCalledTimes(1)
  })
})
