// Server settings opened for a server other than the current one check permissions
// against that server.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { useServerChannelStore } from '@/stores/useServerChannel'
import type { Server } from '@/types'

vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: vi.fn().mockResolvedValue({ isAuthenticated: true, profileId: 'me' }),
  },
}))

vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({ getCurrentUser: ref({ id: 'me' }) }),
}))

vi.mock('@/utils/debug', () => ({
  debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/services/RoleService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/RoleService')>()
  return {
    ...actual,
    roleService: {
      getUserPermissions: vi.fn(async (_user: string, serverId: string) =>
        serverId === 'moderated' ? { [actual.Permission.BAN_MEMBERS]: true } : {}),
      getUserRoles: vi.fn(async () => []),
      hasPermission: vi.fn(async () => false),
    },
  }
})

const { useServerPermissions } = await import('../useServerPermissions')

const server = (id: string, owner: string): Server =>
  ({ id, owner, name: id, is_local_server: true }) as unknown as Server

describe('useServerPermissions(serverId)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const store = useServerChannelStore()
    store.servers = [server('current', 'someone'), server('mine', 'me'), server('moderated', 'someone')]
    store.currentServer = store.servers[0]
  })

  const run = <T>(fn: () => T): T => effectScope().run(fn)!

  it('follows the current server without an id', () => {
    const { serverSettingsPermissions } = run(() => useServerPermissions())
    expect(serverSettingsPermissions.value.canDeleteServer).toBe(false)
    expect(serverSettingsPermissions.value.canEditBasicInfo).toBe(false)
  })

  it('checks the named server, not the current one', () => {
    const { serverSettingsPermissions } = run(() => useServerPermissions(() => 'mine'))
    expect(serverSettingsPermissions.value.canDeleteServer).toBe(true)
    expect(serverSettingsPermissions.value.canEditBasicInfo).toBe(true)
    expect(serverSettingsPermissions.value.canManageBans).toBe(true)
  })

  it('loads permissions for the named server', async () => {
    const { serverSettingsPermissions } = run(() => useServerPermissions(() => 'moderated'))
    expect(serverSettingsPermissions.value.canManageBans).toBe(false)
    await flushPromises()
    expect(serverSettingsPermissions.value.canManageBans).toBe(true)
    expect(serverSettingsPermissions.value.canEditBasicInfo).toBe(false)
  })

  it('grants nothing for a server the user does not belong to', () => {
    const { serverSettingsPermissions } = run(() => useServerPermissions(() => 'elsewhere'))
    expect(serverSettingsPermissions.value.canDeleteServer).toBe(false)
    expect(serverSettingsPermissions.value.canManageBans).toBe(false)
  })
})
