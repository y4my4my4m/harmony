/**
 * UserManagement.vue filter counts: read from the statistics snapshot (one admin_instance_stats
 * request, no HEAD count), moved at once by a suspension here and by an admin:users-changed
 * event's UsersDelta from another tab.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

const moderateUser = vi.fn(async () => {})
const getAdminInstanceStats = vi.fn()
const getUsers = vi.fn()

vi.mock('@/services/AdminService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/AdminService')>()
  return {
    ...actual,
    adminService: {
      getAdminInstanceStats: (...args: unknown[]) => getAdminInstanceStats(...args),
      getUsers: (...args: unknown[]) => getUsers(...args),
      moderateUser: (...args: unknown[]) => moderateUser(...args),
    },
  }
})
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'admin-auth' } } }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: { id: 'admin', is_admin: true } }) }))
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: () => false }))
vi.mock('@/services/userDataService', () => ({ userDataService: { ensureUsersLoaded: vi.fn(async () => {}) } }))
vi.mock('@/composables/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true), prompt: vi.fn(async () => 'spam') }),
}))
vi.mock('@/composables/useT', () => ({ useT: () => ({ t: (key: string) => key }) }))

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/DisplayName.vue', () => stub('DisplayName'))
vi.mock('../CopyIdButton.vue', () => stub('CopyIdButton'))
vi.mock('../UploadLimitDialog.vue', () => stub('UploadLimitDialog'))

import { mapInstanceStats } from '@/services/AdminService'
import UserManagement from '../UserManagement.vue'

enableAutoUnmount(afterEach)

const SNAPSHOT = {
  computed_at: '2026-11-24T07:00:00+00:00', age_seconds: 30, refreshing_elsewhere: false, approximate: [],
  users_total: 100, users_local: 40, users_federated: 60, users_suspended: 3, users_new_24h: 2,
}
const MEMBER = {
  id: 'p1', username: 'spammer', display_name: 'Spammer', created_at: '2026-11-20T00:00:00Z', is_local: true,
  is_admin: false, is_moderator: false, is_suspended: false, force_sensitive: false, is_silenced: false,
  postCount: 0, serverCount: 0, handle: '@spammer',
}

const filterText = (w: ReturnType<typeof mount>) =>
  ['all', 'local', 'federated', 'suspended'].map((k) => w.find(`[data-testid="user-filter-${k}"]`).text())

beforeEach(() => {
  moderateUser.mockClear()
  getAdminInstanceStats.mockReset()
  getAdminInstanceStats.mockImplementation(async () => mapInstanceStats({ ...SNAPSHOT }, 5))
  getUsers.mockReset()
  getUsers.mockImplementation(async () => ({ users: [{ ...MEMBER }], total: 1 }))
})

describe('UserManagement counts', () => {
  it('reads the snapshot once for the filter counts', async () => {
    const w = mount(UserManagement)
    await flushPromises()
    expect(getAdminInstanceStats).toHaveBeenCalledTimes(1)
    expect(getAdminInstanceStats).toHaveBeenCalledWith(false)
    expect(filterText(w)).toEqual(['All users (100)', 'Local (40)', 'Federated (60)', 'Suspended (3)'])
  })

  it('moves Suspended at once when an account is suspended and unsuspended', async () => {
    const w = mount(UserManagement)
    await flushPromises()
    await w.find('.suspend-btn').trigger('click')
    await flushPromises()
    expect(moderateUser).toHaveBeenCalledWith('p1', 'suspend', 'spam', 'admin-auth')
    expect(filterText(w)[3]).toBe('Suspended (4)')
    await w.find('.unsuspend-btn').trigger('click')
    await flushPromises()
    expect(filterText(w)[3]).toBe('Suspended (3)')
    expect(getAdminInstanceStats).toHaveBeenCalledTimes(1)
  })

  it('applies the UsersDelta of an admin:users-changed event', async () => {
    const w = mount(UserManagement)
    await flushPromises()
    window.dispatchEvent(new CustomEvent('admin:users-changed', { detail: { suspended: 5 } }))
    await flushPromises()
    expect(filterText(w)[3]).toBe('Suspended (8)')
    expect(getUsers).toHaveBeenCalledTimes(2)
  })
})
