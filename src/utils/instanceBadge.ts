/**
 * Instance staff badge visibility.
 *
 * `profiles.is_admin` / `is_moderator` are GLOBAL flags identifying the owner
 * /staff of *this* Harmony instance. They must only be surfaced in this
 * instance's own contexts. Inside a federated (remote) server's chat, the
 * instance owner is just a regular member, so the "Instance Admin/Owner" badge
 * must not appear there.
 *
 * `profiles.instance_role` is the staff role a remote account holds on its own
 * instance, as that instance's actor document publishes it. It names that
 * instance, so it shows in every context, the remote server's chat included.
 */

import type { InstanceRole } from '@/types/chat'

interface ServerLike {
  is_local_server?: boolean
}

interface StaffProfile {
  is_admin?: boolean | null
  is_moderator?: boolean | null
  is_local?: boolean | null
  instance_role?: InstanceRole | null
  domain?: string | null
}

export interface InstanceStaffBadge {
  kind: 'admin' | 'mod'
  /** The instance a remote account is staff of; null for this instance's staff. */
  domain: string | null
}

/**
 * Whether instance-staff badges (admin/mod) should be shown in the current
 * context.
 *
 * @param currentServer the server whose chat is being viewed (or null when not
 *   in a server context, e.g. DMs / social feed).
 * @param inServerContext whether the surface is rendered inside a server chat.
 *   Defaults to true (member list / message author are always in server chat).
 */
export function showInstanceStaffBadge(
  currentServer: ServerLike | null | undefined,
  inServerContext = true,
): boolean {
  // Hidden only on a federated server (is_local_server === false).
  if (inServerContext && currentServer?.is_local_server === false) {
    return false
  }
  return true
}

/**
 * The staff badge of an account in the current context: a remote account's
 * role on its own instance, else this instance's staff flags where
 * showInstanceStaffBadge allows them.
 */
export function instanceStaffBadge(
  profile: StaffProfile | null | undefined,
  currentServer: ServerLike | null | undefined,
  inServerContext = true,
): InstanceStaffBadge | null {
  if (!profile) return null
  if (profile.is_local === false) {
    if (profile.instance_role === 'admin') return { kind: 'admin', domain: profile.domain ?? null }
    if (profile.instance_role === 'moderator') return { kind: 'mod', domain: profile.domain ?? null }
    return null
  }
  if (!showInstanceStaffBadge(currentServer, inServerContext)) return null
  if (profile.is_admin) return { kind: 'admin', domain: null }
  if (profile.is_moderator) return { kind: 'mod', domain: null }
  return null
}
