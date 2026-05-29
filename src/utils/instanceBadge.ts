/**
 * Instance staff badge visibility.
 *
 * `profiles.is_admin` / `is_moderator` are GLOBAL flags identifying the owner
 * /staff of *this* Harmony instance. They must only be surfaced in this
 * instance's own contexts. Inside a federated (remote) server's chat, the
 * instance owner is just a regular member, so the "Instance Admin/Owner" badge
 * must not appear there.
 */

interface ServerLike {
  is_local_server?: boolean
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
  // A federated server (is_local_server === false) is the only case we hide in.
  if (inServerContext && currentServer?.is_local_server === false) {
    return false
  }
  return true
}
