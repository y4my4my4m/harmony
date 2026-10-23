/**
 * A loaded server's roles reload after a role write through RoleService and after a realtime
 * role broadcast, once a burst settles; message author colours read the new role colour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const svc = vi.hoisted(() => ({
  color: '#ff0000',
  listeners: [] as Array<(serverId: string) => void>,
  getServerRoles: vi.fn(),
  getRoleMembersForServer: vi.fn(),
  clearServerCache: vi.fn(),
}))

vi.mock('@/services/RoleService', () => ({
  roleService: {
    getServerRoles: svc.getServerRoles,
    getRoleMembersForServer: svc.getRoleMembersForServer,
    clearServerCache: svc.clearServerCache,
    onRolesChanged: (listener: (serverId: string) => void) => {
      svc.listeners.push(listener)
      return () => {}
    },
  },
}))

import { useServerRolesStore } from '@/stores/useServerRoles'

beforeEach(() => {
  vi.useFakeTimers()
  svc.color = '#ff0000'
  svc.listeners.length = 0
  svc.getServerRoles.mockReset().mockImplementation(async () => [
    { id: 'r1', server_id: 's1', name: 'Mods', color: svc.color, position: 2, hoist: true, is_default: false },
    { id: 'r0', server_id: 's1', name: '@everyone', color: '#99AAB5', position: 0, hoist: false, is_default: true },
  ])
  svc.getRoleMembersForServer.mockReset().mockResolvedValue([{ user_id: 'u1', role_id: 'r1' }])
  svc.clearServerCache.mockReset()
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useServerRoles refresh', () => {
  it('reloads a loaded server after a role write, once per burst', async () => {
    const store = useServerRolesStore()
    await store.ensureServerLoaded('s1')
    expect(store.getUserRoleColor('s1', 'u1')).toBe('#ff0000')

    svc.color = '#00ff00'
    for (const listener of svc.listeners) {
      listener('s1')
      listener('s1')
    }
    await vi.advanceTimersByTimeAsync(300)

    expect(svc.getServerRoles).toHaveBeenCalledTimes(2)
    expect(svc.getServerRoles).toHaveBeenLastCalledWith('s1', true)
    expect(store.getUserRoleColor('s1', 'u1')).toBe('#00ff00')
    expect(svc.clearServerCache).not.toHaveBeenCalled()
  })

  it('reloads after a realtime role broadcast, clearing the service caches first', async () => {
    const store = useServerRolesStore()
    await store.ensureServerLoaded('s1')

    svc.color = '#0000ff'
    window.dispatchEvent(new CustomEvent('server-structure:role-change', {
      detail: { new: { id: 'r1', server_id: 's1', color: '#0000ff' } },
    }))
    await vi.advanceTimersByTimeAsync(300)

    expect(svc.clearServerCache).toHaveBeenCalledWith('s1')
    expect(store.getUserRoleColor('s1', 'u1')).toBe('#0000ff')
  })

  it('leaves a server it never loaded alone', async () => {
    useServerRolesStore()
    for (const listener of svc.listeners) listener('s2')
    window.dispatchEvent(new CustomEvent('server-structure:user-role-change', { detail: { old: { server_id: 's2' } } }))
    await vi.advanceTimersByTimeAsync(300)
    expect(svc.getServerRoles).not.toHaveBeenCalled()
  })
})
