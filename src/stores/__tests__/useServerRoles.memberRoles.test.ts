/**
 * With the member directory, a member's roles load when a getter first asks for them, one
 * request per tick, or arrive with the member list. No request reads every assignment.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const svc = vi.hoisted(() => ({
  getServerRoles: vi.fn(),
  getRoleMembersForServer: vi.fn(),
  fetchMemberRoles: vi.fn(),
  listeners: [] as Array<(serverId: string) => void>,
  available: true,
}))

vi.mock('@/services/RoleService', () => ({
  roleService: {
    getServerRoles: svc.getServerRoles,
    getRoleMembersForServer: svc.getRoleMembersForServer,
    clearServerCache: vi.fn(),
    onRolesChanged: (listener: (serverId: string) => void) => {
      svc.listeners.push(listener)
      return () => {}
    },
  },
}))
vi.mock('@/services/memberDirectoryService', () => ({
  memberDirectoryAvailable: () => svc.available,
  fetchMemberRoles: svc.fetchMemberRoles,
  MEMBER_ROLES_MAX: 200,
}))

import { useServerRolesStore } from '@/stores/useServerRoles'

const ROLES = [
  { id: 'mods', server_id: 's1', name: 'Mods', color: '#ff0000', position: 3, hoist: true, is_default: false },
  { id: 'vip', server_id: 's1', name: 'VIP', color: '#00ff00', position: 2, hoist: false, is_default: false },
  { id: 'everyone', server_id: 's1', name: '@everyone', color: '#99AAB5', position: 0, hoist: false, is_default: true },
]
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  svc.available = true
  svc.listeners.length = 0
  svc.getServerRoles.mockReset().mockResolvedValue(ROLES)
  svc.getRoleMembersForServer.mockReset().mockResolvedValue([])
  svc.fetchMemberRoles.mockReset().mockImplementation(async (_server: string, ids: string[]) =>
    Object.fromEntries(ids.filter(id => id === 'u1').map(id => [id, ['vip', 'mods']])))
  setActivePinia(createPinia())
})

describe('member roles on demand', () => {
  it('loading a server reads its roles and no assignment list', async () => {
    const store = useServerRolesStore()
    await store.ensureServerLoaded('s1')
    expect(svc.getServerRoles).toHaveBeenCalledTimes(1)
    expect(svc.getRoleMembersForServer).not.toHaveBeenCalled()
    expect(svc.fetchMemberRoles).not.toHaveBeenCalled()
  })

  it('getters asked in one tick load their members in one request', async () => {
    const store = useServerRolesStore()
    await store.ensureServerLoaded('s1')
    expect(store.getUserRoleColor('s1', 'u1')).toBeNull()
    expect(store.getHighestHoistedRole('s1', 'u2')).toBeNull()
    expect(store.getUserRoleColor('s1', 'u1')).toBeNull()
    await tick()

    expect(svc.fetchMemberRoles).toHaveBeenCalledTimes(1)
    expect(svc.fetchMemberRoles).toHaveBeenCalledWith('s1', ['u1', 'u2'])
    expect(store.getUserRoleColor('s1', 'u1'), 'the highest coloured role').toBe('#ff0000')
    expect(store.getHighestHoistedRole('s1', 'u1')?.id).toBe('mods')
  })

  it('a member without roles is asked once', async () => {
    const store = useServerRolesStore()
    await store.ensureServerLoaded('s1')
    store.getUserRoleColor('s1', 'u2')
    await tick()
    store.getUserRoleColor('s1', 'u2')
    await tick()
    expect(svc.fetchMemberRoles).toHaveBeenCalledTimes(1)
    expect(store.getUserRoleColor('s1', 'u2')).toBeNull()
  })

  it('roles that arrive with the member list need no request', async () => {
    const store = useServerRolesStore()
    await store.ensureServerLoaded('s1')
    store.setMemberRoles('s1', [{ id: 'u3', role_ids: ['vip'] }, { id: 'u4', role_ids: [] }])
    expect(store.getUserRoleColor('s1', 'u3')).toBe('#00ff00')
    expect(store.getUserRoleColor('s1', 'u4')).toBeNull()
    await tick()
    expect(svc.fetchMemberRoles).not.toHaveBeenCalled()
  })

  it('roles set before the server roles load resolve once they do', async () => {
    const store = useServerRolesStore()
    store.setMemberRoles('s1', [{ id: 'u3', role_ids: ['mods'] }])
    await store.ensureServerLoaded('s1')
    expect(store.getUserRoleColor('s1', 'u3')).toBe('#ff0000')
  })

  it('a role change reloads the roles and asks again for the members in view', async () => {
    vi.useFakeTimers()
    try {
      const store = useServerRolesStore()
      await store.ensureServerLoaded('s1')
      store.getUserRoleColor('s1', 'u1')
      await vi.advanceTimersByTimeAsync(1)
      expect(store.getUserRoleColor('s1', 'u1')).toBe('#ff0000')

      svc.fetchMemberRoles.mockResolvedValue({ u1: ['vip'] })
      for (const listener of svc.listeners) listener('s1')
      await vi.advanceTimersByTimeAsync(300)
      expect(svc.getServerRoles).toHaveBeenLastCalledWith('s1', true)

      expect(store.getUserRoleColor('s1', 'u1'), 'the colour known stays until it is read again').toBe('#ff0000')
      await vi.advanceTimersByTimeAsync(1)
      expect(svc.fetchMemberRoles).toHaveBeenCalledTimes(2)
      expect(store.getUserRoleColor('s1', 'u1')).toBe('#00ff00')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a member who lost every role reads as none after the reload', async () => {
    vi.useFakeTimers()
    try {
      const store = useServerRolesStore()
      await store.ensureServerLoaded('s1')
      store.setMemberRoles('s1', [{ id: 'u1', role_ids: ['mods'] }])
      svc.fetchMemberRoles.mockResolvedValue({})
      for (const listener of svc.listeners) listener('s1')
      await vi.advanceTimersByTimeAsync(300)
      expect(store.getUserRoleColor('s1', 'u1')).toBe('#ff0000')
      await vi.advanceTimersByTimeAsync(1)
      expect(store.getUserRoleColor('s1', 'u1')).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      expect(svc.fetchMemberRoles).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failed request is tried again on the next ask', async () => {
    const store = useServerRolesStore()
    await store.ensureServerLoaded('s1')
    svc.fetchMemberRoles.mockRejectedValueOnce(new Error('network'))
    store.getUserRoleColor('s1', 'u1')
    await tick()
    expect(store.getUserRoleColor('s1', 'u1')).toBeNull()
    await tick()
    expect(svc.fetchMemberRoles).toHaveBeenCalledTimes(2)
    expect(store.getUserRoleColor('s1', 'u1')).toBe('#ff0000')
  })

  it('an instance without the per-member read falls back to every assignment', async () => {
    const store = useServerRolesStore()
    await store.ensureServerLoaded('s1')
    // As fetchMemberRoles answers on PGRST202: null, and unavailable from then on.
    svc.fetchMemberRoles.mockImplementation(async () => { svc.available = false; return null })
    svc.getRoleMembersForServer.mockResolvedValue([{ user_id: 'u1', role_id: 'vip' }])
    expect(store.getUserRoleColor('s1', 'u1')).toBeNull()
    await tick()
    await tick()
    expect(svc.getRoleMembersForServer).toHaveBeenCalledWith('s1')
    expect(store.getUserRoleColor('s1', 'u1')).toBe('#00ff00')
    expect(store.getUserRoleColor('s1', 'u9')).toBeNull()
    await tick()
    expect(svc.fetchMemberRoles, 'asked once').toHaveBeenCalledTimes(1)
  })

  it('an unloaded server asks nothing', async () => {
    const store = useServerRolesStore()
    expect(store.getUserRoleColor('s9', 'u1')).toBeNull()
    await tick()
    expect(svc.fetchMemberRoles).not.toHaveBeenCalled()
  })
})
