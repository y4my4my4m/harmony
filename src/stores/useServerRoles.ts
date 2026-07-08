import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { roleService, type ServerRole } from '@/services/RoleService'
import { debug } from '@/utils/debug'

// Batched server_roles + user_roles fetch; sync getters keyed by (serverId, userId).
export const useServerRolesStore = defineStore('serverRoles', () => {
  const rolesByServer = ref(new Map<string, ServerRole[]>())
  const userRolesByServer = ref(new Map<string, Map<string, ServerRole[]>>())
  const inflight = new Map<string, Promise<void>>()
  const _tick = ref(0)

  async function ensureServerLoaded(serverId: string, options?: { force?: boolean }): Promise<void> {
    if (!serverId) return
    if (!options?.force && rolesByServer.value.has(serverId)) return
    const existing = inflight.get(serverId)
    if (existing) return existing

    const work = (async () => {
      try {
        const roles = await roleService.getServerRoles(serverId, options?.force)
        const sortedRoles = [...roles].sort((a, b) => b.position - a.position)
        rolesByServer.value.set(serverId, sortedRoles)

        const roleMap = new Map(sortedRoles.map(r => [r.id, r]))
        const assignments = await roleService.getRoleMembersForServer(serverId)
        const userRoles = new Map<string, ServerRole[]>()
        for (const a of assignments) {
          const role = roleMap.get(a.role_id)
          if (!role) continue
          if (!userRoles.has(a.user_id)) userRoles.set(a.user_id, [])
          userRoles.get(a.user_id)!.push(role)
        }
        for (const list of userRoles.values()) {
          list.sort((a, b) => b.position - a.position)
        }
        userRolesByServer.value.set(serverId, userRoles)
        _tick.value++
        debug.log(`ServerRolesStore: loaded ${sortedRoles.length} roles, ${userRoles.size} member assignments for ${serverId}`)
      } catch (err) {
        debug.error('ServerRolesStore: load failed for', serverId, err)
      } finally {
        inflight.delete(serverId)
      }
    })()
    inflight.set(serverId, work)
    return work
  }

  function getHighestColoredRole(serverId: string | null | undefined, userId: string | null | undefined): ServerRole | null {
    if (!serverId || !userId) return null
    void _tick.value
    const userRoles = userRolesByServer.value.get(serverId)?.get(userId)
    if (!userRoles || userRoles.length === 0) return null
    return userRoles.find(r => !!r.color && r.color !== '#99AAB5') || null
  }

  function getHighestHoistedRole(serverId: string | null | undefined, userId: string | null | undefined): ServerRole | null {
    if (!serverId || !userId) return null
    void _tick.value
    const userRoles = userRolesByServer.value.get(serverId)?.get(userId)
    if (!userRoles || userRoles.length === 0) return null
    return userRoles.find(r => r.hoist && !r.is_default) || null
  }

  function getUserRoleColor(serverId: string | null | undefined, userId: string | null | undefined): string | null {
    return getHighestColoredRole(serverId, userId)?.color || null
  }

  function invalidate(serverId: string): void {
    rolesByServer.value.delete(serverId)
    userRolesByServer.value.delete(serverId)
    _tick.value++
  }

  function $dispose(): void {
    rolesByServer.value.clear()
    userRolesByServer.value.clear()
    inflight.clear()
    _tick.value++
  }

  const isLoaded = computed(() => (serverId: string) => rolesByServer.value.has(serverId))

  return {
    rolesByServer,
    userRolesByServer,
    ensureServerLoaded,
    getHighestColoredRole,
    getHighestHoistedRole,
    getUserRoleColor,
    invalidate,
    isLoaded,
    $dispose,
  }
})
