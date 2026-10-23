import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { roleService, type ServerRole } from '@/services/RoleService'
import { debug } from '@/utils/debug'

// Batched server_roles + user_roles fetch; sync getters keyed by (serverId, userId).
// A loaded server reloads after role writes through RoleService and after realtime role
// broadcasts (server-structure:role-change / user-role-change), REFRESH_DEBOUNCE_MS apart.
const REFRESH_DEBOUNCE_MS = 250

export const useServerRolesStore = defineStore('serverRoles', () => {
  const rolesByServer = ref(new Map<string, ServerRole[]>())
  const userRolesByServer = ref(new Map<string, Map<string, ServerRole[]>>())
  const inflight = new Map<string, Promise<void>>()
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const _tick = ref(0)

  async function ensureServerLoaded(serverId: string, options?: { force?: boolean }): Promise<void> {
    if (!serverId) return
    if (!options?.force && rolesByServer.value.has(serverId)) return
    const existing = inflight.get(serverId)
    if (existing) {
      if (!options?.force) return existing
      // A load started before the change settles with the old rows.
      await existing.catch(() => {})
      if (inflight.get(serverId)) return inflight.get(serverId)
    }

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

  /** Reloads `serverId` once a burst of changes settles; servers never loaded stay unloaded. */
  function scheduleRefresh(serverId: string, { clearService = false } = {}): void {
    if (!serverId || !rolesByServer.value.has(serverId)) return
    const pending = refreshTimers.get(serverId)
    if (pending) clearTimeout(pending)
    refreshTimers.set(serverId, setTimeout(() => {
      refreshTimers.delete(serverId)
      if (clearService) roleService.clearServerCache(serverId)
      void ensureServerLoaded(serverId, { force: true })
    }, REFRESH_DEBOUNCE_MS))
  }

  roleService.onRolesChanged((serverId) => scheduleRefresh(serverId))

  // Changes made elsewhere: RoleService's own caches (assignments live 30 s) are stale too.
  if (typeof window !== 'undefined') {
    const onBroadcast = (event: Event) => {
      const detail = (event as CustomEvent).detail
      const serverId = detail?.new?.server_id ?? detail?.old?.server_id
      if (serverId) scheduleRefresh(serverId, { clearService: true })
    }
    window.addEventListener('server-structure:role-change', onBroadcast)
    window.addEventListener('server-structure:user-role-change', onBroadcast)
  }

  function invalidate(serverId: string): void {
    rolesByServer.value.delete(serverId)
    userRolesByServer.value.delete(serverId)
    _tick.value++
  }

  function $dispose(): void {
    for (const timer of refreshTimers.values()) clearTimeout(timer)
    refreshTimers.clear()
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
