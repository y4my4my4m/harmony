/**
 * AdminPanel.vue Emojis tab: one list, AdminEmojiLibrary, holds every emoji of the instance;
 * the separate library, browse list and remote importer are gone.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

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

vi.mock('@/components/admin/AdminEmojiLibrary.vue', async () => {
  const { defineComponent, h } = await import('vue')
  // __esModule: defineAsyncComponent takes `default` only from a module it recognises.
  return {
    __esModule: true,
    default: defineComponent({ name: 'AdminEmojiLibrary', render: () => h('section', { class: 'library-stub' }) }),
  }
})

import AdminPanel from '../AdminPanel.vue'

enableAutoUnmount(afterEach)

describe('AdminPanel emojis tab', () => {
  it('shows the one emoji list', async () => {
    const w = mount(AdminPanel, { global: { mocks: { $t: (key: string) => key } } })
    await flushPromises()
    await vi.dynamicImportSettled()
    await flushPromises()
    expect(w.findAllComponents({ name: 'AdminEmojiLibrary' })).toHaveLength(1)
    expect(w.text()).not.toContain('Remote emoji importer')
  })
})
