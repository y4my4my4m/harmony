/**
 * useServerRolesStore
 *
 * Single source of truth for "what roles does user X have in server Y" so the
 * answer can drive both the role-grouped UserSidebar AND the per-message
 * username color in MessageDisplay without each component fetching twice.
 *
 * Why this exists:
 *   - `roleService.userRolesCache` is keyed by `${userId}-${serverId}` and is
 *     populated lazily on demand. Walking N messages on render to ask the
 *     service "what's this user's role color" would either trigger N async
 *     fetches or fall back to user.color for everyone we haven't asked for.
 *   - `UserSidebar` already did a batched server-wide fetch for the hoist
 *     feature, but the result lived in component-local refs and was filtered
 *     to *hoisted* roles only. Chat name color wants ANY role with a color,
 *     hoisted or not, by highest position - same as Discord.
 *
 * This store does one batched fetch per server (server_roles + user_roles in
 * 2 queries) and exposes synchronous getters keyed by (serverId, userId).
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { roleService, type ServerRole } from '@/services/RoleService'
import { debug } from '@/utils/debug'

export const useServerRolesStore = defineStore('serverRoles', () => {
  /** serverId -> sorted-by-position-desc ServerRole[] */
  const rolesByServer = ref(new Map<string, ServerRole[]>())
  /** serverId -> Map<userId, ServerRole[]> (each user's roles sorted by position desc) */
  const userRolesByServer = ref(new Map<string, Map<string, ServerRole[]>>())
  /** In-flight loads per server, deduplicated. */
  const inflight = new Map<string, Promise<void>>()
  /** Force-update bump used by computed getters; mutating Map.set in-place
   *  doesn't trigger Pinia reactivity, so we bump this instead. */
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
        debug.log(`🎭 ServerRolesStore: loaded ${sortedRoles.length} roles, ${userRoles.size} member assignments for ${serverId}`)
      } catch (err) {
        debug.error('🎭 ServerRolesStore: load failed for', serverId, err)
      } finally {
        inflight.delete(serverId)
      }
    })()
    inflight.set(serverId, work)
    return work
  }

  /** Synchronous lookup: highest-position role with a non-empty color. */
  function getHighestColoredRole(serverId: string | null | undefined, userId: string | null | undefined): ServerRole | null {
    if (!serverId || !userId) return null
    void _tick.value
    const userRoles = userRolesByServer.value.get(serverId)?.get(userId)
    if (!userRoles || userRoles.length === 0) return null
    return userRoles.find(r => !!r.color && r.color !== '#99AAB5') || null
  }

  /** Synchronous lookup: highest-position hoisted role (for the sidebar grouping). */
  function getHighestHoistedRole(serverId: string | null | undefined, userId: string | null | undefined): ServerRole | null {
    if (!serverId || !userId) return null
    void _tick.value
    const userRoles = userRolesByServer.value.get(serverId)?.get(userId)
    if (!userRoles || userRoles.length === 0) return null
    return userRoles.find(r => r.hoist && !r.is_default) || null
  }

  /**
   * Get the display color for a user in a server context. Returns the highest
   * role color the user holds; returns `null` if the user has no colored role
   * (caller falls back to user's profile color or default).
   */
  function getUserRoleColor(serverId: string | null | undefined, userId: string | null | undefined): string | null {
    return getHighestColoredRole(serverId, userId)?.color || null
  }

  /** Invalidate a single server's data (e.g. role list edited, member joined). */
  function invalidate(serverId: string): void {
    rolesByServer.value.delete(serverId)
    userRolesByServer.value.delete(serverId)
    _tick.value++
  }

  /** All-server invalidate (logout). */
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
