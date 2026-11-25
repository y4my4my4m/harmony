import type { ServerRole } from '@/services/RoleService'

export type SelfAssignProblem = 'default' | 'admin' | 'grants' | 'rank'

function grantsBeyond(role: ServerRole, everyone: ServerRole | undefined): boolean {
  const base = (everyone?.permissions ?? {}) as Record<string, boolean>
  return Object.entries(role.permissions ?? {}).some(([name, held]) => held && !base[name])
}

/**
 * Why members could not pick `role`, as self_assign_refusal (20261116400001) decides from the
 * roles alone: @everyone, an administrator role, server permissions beyond @everyone's, or a
 * position at or above a role granting such permissions. Channel overrides are checked by the
 * server only.
 */
export function selfAssignProblem(role: ServerRole, roles: readonly ServerRole[]): SelfAssignProblem | null {
  if (role.is_default) return 'default'
  if (role.is_admin) return 'admin'
  const everyone = roles.find((r) => r.is_default)
  if (grantsBeyond(role, everyone)) return 'grants'
  const outranks = roles.some((r) =>
    r.id !== role.id && !r.is_default && (r.is_admin || grantsBeyond(r, everyone)) && r.position <= role.position)
  return outranks ? 'rank' : null
}

export interface PickableRoleGroup {
  /** self_assign_group; null for roles without one. */
  name: string | null
  roles: ServerRole[]
}

/**
 * Roles members may pick, by group: named groups alphabetically, then ungrouped roles; highest
 * position first within a group. `group` limits the result to that group.
 */
export function pickableRoleGroups(roles: readonly ServerRole[], group?: string | null): PickableRoleGroup[] {
  const byGroup = new Map<string | null, ServerRole[]>()
  for (const role of roles) {
    if (!role.self_assignable || selfAssignProblem(role, roles)) continue
    const name = role.self_assign_group?.trim() || null
    if (group && name !== group) continue
    const list = byGroup.get(name)
    if (list) list.push(role)
    else byGroup.set(name, [role])
  }
  const named = [...byGroup.keys()].filter((k): k is string => k !== null).sort((a, b) => a.localeCompare(b))
  const order: Array<string | null> = byGroup.has(null) ? [...named, null] : named
  return order.map((name) => ({
    name,
    roles: byGroup.get(name)!.slice().sort((a, b) => b.position - a.position),
  }))
}

/** Distinct self_assign_group names of `roles`, alphabetically. */
export function selfAssignGroupNames(roles: readonly ServerRole[]): string[] {
  const names = new Set<string>()
  for (const role of roles) {
    const name = role.self_assign_group?.trim()
    if (role.self_assignable && name) names.add(name)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}
