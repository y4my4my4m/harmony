/**
 * admin_audit_log rows of instance staff actions on chat servers and of domain report handling,
 * as one line: what was done, to whom or what, and why. Null for any other action type.
 *
 *   action_type                         target    action_details
 *   server_member_remove, _ban          server    server_name, user_id, username, domain, reason (20261027250001)
 *   server_message_remove               message   server_id, channel_id, author_id, reason
 *   server_suspend, server_unsuspend    server    server_name, reason
 *   server_delete                       server    server_name, owner_username, members, remote_members, reason
 *   instance_server_blocked, _unblocked server    name, reason, members_removed (20261027300001)
 *   instance_server_media_hidden, _shown server   name
 *   instance_server_member_removed      user      username, server_id, server_name, reason, removed, kept_out
 *   instance_server_keepout_lifted      user      server_id
 *   domain_reject_reports, _accept_     domain    (none) (20261027400001)
 */

type Translate = (key: string, ...args: unknown[]) => string

export interface StaffActivityEntry {
  action_type: string
  target_id?: string | null
  /** Username of a 'user' target. */
  target_username?: string | null
  details?: Record<string, unknown> | null
  /** Name of the server whose id the details carry without one. */
  server_name?: string | null
  /** Handle of details.author_id. */
  author_handle?: string | null
}

const K = 'admin.activityLog.staff'

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function handle(username: unknown, domain?: unknown): string | null {
  const name = text(username)
  if (!name) return null
  const host = text(domain)
  return host ? `@${name}@${host}` : `@${name}`
}

/** Server id of a row whose details carry no server name. */
export function staffActivityServerId(entry: Pick<StaffActivityEntry, 'action_type' | 'details'>): string | null {
  if (entry.action_type !== 'server_message_remove' && entry.action_type !== 'instance_server_keepout_lifted') return null
  return text(entry.details?.server_id)
}

/** Author of a removed message: a profile id, or a bot id that names no profile. */
export function staffActivityAuthorId(entry: Pick<StaffActivityEntry, 'action_type' | 'details'>): string | null {
  return entry.action_type === 'server_message_remove' ? text(entry.details?.author_id) : null
}

export function staffActivityMessage(entry: StaffActivityEntry, instance: string, t: Translate): string | null {
  const d = entry.details ?? {}
  const server = text(d.server_name) ?? text(d.name) ?? text(entry.server_name) ?? t(`${K}.someServer`)
  const reason = text(d.reason)
  const withReason = (line: string) => (reason ? `${line} · ${t(`${K}.reason`, { reason })}` : line)

  switch (entry.action_type) {
    case 'server_member_remove':
    case 'server_member_ban': {
      const person = handle(d.username, d.domain) ?? t(`${K}.someone`)
      const key = entry.action_type === 'server_member_ban' ? 'memberBanned' : 'memberRemoved'
      return withReason(t(`${K}.${key}`, { person, server }))
    }
    case 'server_message_remove': {
      const person = text(entry.author_handle)
      return withReason(person
        ? t(`${K}.messageRemovedBy`, { person, server })
        : t(`${K}.messageRemoved`, { server }))
    }
    case 'server_suspend':
      return withReason(t(`${K}.serverSuspended`, { server }))
    case 'server_unsuspend':
      return withReason(t(`${K}.serverUnsuspended`, { server }))
    case 'server_delete': {
      const owner = handle(d.owner_username)
      return withReason(owner
        ? t(`${K}.serverDeletedOwned`, { server, person: owner })
        : t(`${K}.serverDeleted`, { server }))
    }
    case 'instance_server_blocked': {
      const left = typeof d.members_removed === 'number' ? d.members_removed : 0
      const line = t(`${K}.serverBlocked`, { server, instance })
      return withReason(left > 0 ? `${line} · ${t(`${K}.peopleLeft`, { count: left, instance }, left)}` : line)
    }
    case 'instance_server_unblocked':
      return t(`${K}.serverUnblocked`, { server, instance })
    case 'instance_server_media_hidden':
      return t(`${K}.mediaHidden`, { server, instance })
    case 'instance_server_media_shown':
      return t(`${K}.mediaShown`, { server, instance })
    case 'instance_server_member_removed': {
      const person = handle(entry.target_username ?? d.username) ?? t(`${K}.someone`)
      const removed = d.removed !== false
      const keptOut = d.kept_out === true
      const key = removed && keptOut ? 'removedHereKeptOut' : removed ? 'removedHere' : 'keptOutHere'
      return withReason(t(`${K}.${key}`, { person, server, instance }))
    }
    case 'instance_server_keepout_lifted': {
      const person = handle(entry.target_username) ?? t(`${K}.someone`)
      return t(`${K}.keepoutLifted`, { person, server, instance })
    }
    case 'domain_reject_reports':
      return t(`${K}.reportsRejected`, { domain: entry.target_id ?? '' })
    case 'domain_accept_reports':
      return t(`${K}.reportsAccepted`, { domain: entry.target_id ?? '' })
    default:
      return null
  }
}
