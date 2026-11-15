import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { roleService, type ServerRole } from '@/services/RoleService'
import { fetchMemberRoles, memberDirectoryAvailable, MEMBER_ROLES_MAX } from '@/services/memberDirectoryService'
import { debug } from '@/utils/debug'

// Server roles with sync getters keyed by (serverId, userId).
//
// With the member directory, a member's roles load when a getter first asks for them
// (get_server_member_roles, batched per tick) or arrive with the member list; no request
// reads every assignment of a server. Without it, one paged user_roles read fills the map.
// A loaded server reloads after role writes through RoleService and after realtime role
// broadcasts (server-structure:role-change / user-role-change), REFRESH_DEBOUNCE_MS apart.
const REFRESH_DEBOUNCE_MS = 250

export const useServerRolesStore = defineStore('serverRoles', () => {
  const rolesByServer = ref(new Map<string, ServerRole[]>())
  const userRolesByServer = ref(new Map<string, Map<string, ServerRole[]>>())
  const inflight = new Map<string, Promise<void>>()
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const _tick = ref(0)
  // Servers whose member roles load per member, with the role ids known so far. An id list
  // outlives a role reload; the ServerRole lists in userRolesByServer are rebuilt from it.
  const memberRoleIds = new Map<string, Map<string, string[]>>()
  const queued = new Map<string, Set<string>>()
  const asked = new Map<string, Set<string>>()
  // Members whose roles predate a role or assignment change: shown as known, read again on ask.
  const outdated = new Map<string, Set<string>>()
  let flushQueued = false

  function rolesOf(serverId: string, roleIds: string[]): ServerRole[] {
    const byId = new Map((rolesByServer.value.get(serverId) ?? []).map(r => [r.id, r]))
    return roleIds
      .map(id => byId.get(id))
      .filter((r): r is ServerRole => !!r)
      .sort((a, b) => b.position - a.position)
  }

  /** Roles of members as the directory answered them: role ids, default role left out. */
  function setMemberRoles(serverId: string, members: Array<{ id: string; role_ids?: string[] | null }>): void {
    if (!serverId || members.length === 0) return
    let ids = memberRoleIds.get(serverId)
    if (!ids) memberRoleIds.set(serverId, (ids = new Map()))
    let lists = userRolesByServer.value.get(serverId)
    if (!lists) userRolesByServer.value.set(serverId, (lists = new Map()))
    const old = outdated.get(serverId)
    for (const member of members) {
      const roleIds = member.role_ids ?? []
      ids.set(member.id, roleIds)
      lists.set(member.id, rolesOf(serverId, roleIds))
      old?.delete(member.id)
    }
    _tick.value++
  }

  // Getters run during render: the ids asked in one tick go out as one request.
  function queueMemberRoles(serverId: string, userId: string): void {
    if (!memberRoleIds.has(serverId)) return
    let seen = asked.get(serverId)
    if (!seen) asked.set(serverId, (seen = new Set()))
    if (seen.has(userId)) return
    seen.add(userId)
    let pending = queued.get(serverId)
    if (!pending) queued.set(serverId, (pending = new Set()))
    pending.add(userId)
    if (flushQueued) return
    flushQueued = true
    queueMicrotask(() => {
      flushQueued = false
      const batches = [...queued.entries()]
      queued.clear()
      for (const [server, userIds] of batches) void loadMemberRoles(server, [...userIds])
    })
  }

  async function loadMemberRoles(serverId: string, userIds: string[]): Promise<void> {
    for (let i = 0; i < userIds.length; i += MEMBER_ROLES_MAX) {
      const chunk = userIds.slice(i, i + MEMBER_ROLES_MAX)
      try {
        const roles = await fetchMemberRoles(serverId, chunk)
        if (!memberRoleIds.has(serverId)) return
        if (!roles) {
          // The instance has no get_server_member_roles: every assignment, read once.
          memberRoleIds.delete(serverId)
          asked.delete(serverId)
          outdated.delete(serverId)
          void ensureServerLoaded(serverId, { force: true })
          return
        }
        // A member without roles is absent from the answer and is stored empty: asked once.
        setMemberRoles(serverId, chunk.map(id => ({ id, role_ids: roles[id] ?? [] })))
      } catch (err) {
        debug.warn('ServerRolesStore: member roles failed for', serverId, err)
        const seen = asked.get(serverId)
        chunk.forEach(id => seen?.delete(id))
      }
    }
  }

  /** Loads the roles of these members now, for a view that knows whom it shows. */
  function ensureMemberRoles(serverId: string | null | undefined, userIds: string[]): void {
    if (!serverId) return
    for (const userId of userIds) {
      if (userId) memberRoles(serverId, userId)
    }
  }

  function memberRoles(serverId: string, userId: string): ServerRole[] | undefined {
    const userRoles = userRolesByServer.value.get(serverId)?.get(userId)
    if (!userRoles || outdated.get(serverId)?.has(userId)) queueMemberRoles(serverId, userId)
    return userRoles
  }

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

        if (memberDirectoryAvailable()) {
          // A forced reload follows a role or assignment change: the roles known stay on
          // screen and are read again as their members are asked for.
          const known = memberRoleIds.get(serverId) ?? new Map<string, string[]>()
          memberRoleIds.set(serverId, known)
          if (options?.force) {
            outdated.set(serverId, new Set(known.keys()))
            asked.delete(serverId)
          }
          const lists = new Map<string, ServerRole[]>()
          for (const [userId, roleIds] of memberRoleIds.get(serverId)!) lists.set(userId, rolesOf(serverId, roleIds))
          userRolesByServer.value.set(serverId, lists)
          _tick.value++
          return
        }
        memberRoleIds.delete(serverId)

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
    const userRoles = memberRoles(serverId, userId)
    if (!userRoles || userRoles.length === 0) return null
    return userRoles.find(r => !!r.color && r.color !== '#99AAB5') || null
  }

  function getHighestHoistedRole(serverId: string | null | undefined, userId: string | null | undefined): ServerRole | null {
    if (!serverId || !userId) return null
    void _tick.value
    const userRoles = memberRoles(serverId, userId)
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
    memberRoleIds.delete(serverId)
    asked.delete(serverId)
    outdated.delete(serverId)
    _tick.value++
  }

  function $dispose(): void {
    for (const timer of refreshTimers.values()) clearTimeout(timer)
    refreshTimers.clear()
    rolesByServer.value.clear()
    userRolesByServer.value.clear()
    memberRoleIds.clear()
    asked.clear()
    outdated.clear()
    queued.clear()
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
    setMemberRoles,
    ensureMemberRoles,
    invalidate,
    isLoaded,
    $dispose,
  }
})
