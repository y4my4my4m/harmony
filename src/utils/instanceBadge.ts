/**
 * Instance staff badges.
 *
 * `profiles.is_admin` / `is_moderator` name the staff of this instance.
 * `profiles.instance_role` is the staff role a remote account holds on its own
 * instance, as that instance's actor document publishes it.
 *
 * Next to a name (message header, member list, post): staff of the instance
 * that hosts the context only (contextStaffBadge). On a profile card: the
 * account's own staff role, naming a remote account's instance
 * (instanceStaffBadge).
 */

import type { InstanceRole } from '@/types/chat'

interface ServerLike {
  is_local_server?: boolean
  /** Host of a copy's Group (servers.federation_domain). */
  federation_domain?: string | null
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
  /** The instance the account is staff of; null where the badge leaves it unnamed. */
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
 * The staff badge of a profile card: a remote account's role on its own
 * instance, else this instance's staff flags where showInstanceStaffBadge
 * allows them.
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

function hostName(domain: string | null | undefined): string {
  return (domain ?? '').trim().toLowerCase()
}

/**
 * The staff badge next to a name: staff of the instance hosting the context,
 * named by its domain.
 *
 * A server hosted here, and every context outside a server (DMs, group DMs,
 * the social side), show this instance's staff. A copy of a server hosted
 * elsewhere shows its host's staff, as the host's actors publish their role
 * (profiles.instance_role), and this instance's staff are ordinary members
 * there. Staff of any other instance get no badge; their profile card names
 * them.
 *
 * @param server the server whose chat holds the name; null outside a server.
 * @param localDomain this instance's domain.
 */
export function contextStaffBadge(
  profile: StaffProfile | null | undefined,
  server: ServerLike | null | undefined,
  localDomain: string | null | undefined,
): InstanceStaffBadge | null {
  if (!profile) return null
  if (server?.is_local_server === false) {
    const host = hostName(server.federation_domain)
    if (!host || profile.is_local !== false || hostName(profile.domain) !== host) return null
    if (profile.instance_role === 'admin') return { kind: 'admin', domain: server.federation_domain!.trim() }
    if (profile.instance_role === 'moderator') return { kind: 'mod', domain: server.federation_domain!.trim() }
    return null
  }
  if (profile.is_local === false) return null
  const domain = localDomain?.trim() || null
  if (profile.is_admin) return { kind: 'admin', domain }
  if (profile.is_moderator) return { kind: 'mod', domain }
  return null
}
