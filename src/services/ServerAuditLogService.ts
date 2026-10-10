/**
 * Per-server audit log (20261010600001_server_audit_log.sql). Rows are written by database
 * triggers; get_server_audit_log admits the owner, instance admins and VIEW_AUDIT_LOG holders.
 */
import { supabase } from '@/supabase'

export type ServerAuditSource = 'user' | 'bot' | 'federation' | 'system'

/** {column: {old, new}}; a create carries new only, a delete old only. */
export type ServerAuditChanges = Record<string, { old?: unknown; new?: unknown }>

export interface ServerAuditEntry {
  id: string
  created_at: string
  /** '<kind>.<verb>', e.g. 'channel.update', 'member.kick'. */
  action: string
  source: ServerAuditSource
  actor_id: string | null
  actor_username: string | null
  actor_display_name: string | null
  actor_avatar_url: string | null
  actor_bot_id: string | null
  actor_bot_name: string | null
  actor_bot_avatar_url: string | null
  target_type: string | null
  target_id: string | null
  /** Current username for a member target, else the name stored with the entry. */
  target_name: string | null
  target_display_name: string | null
  target_avatar_url: string | null
  changes: ServerAuditChanges | null
  details: Record<string, any> | null
  reason: string | null
}

export interface ServerAuditQuery {
  /** created_at of the oldest entry already shown. */
  before?: string | null
  limit?: number
  /** An action ('role.update') or a kind ('role'). */
  action?: string | null
  actorId?: string | null
}

/** The database caps a page at 100. */
export const AUDIT_PAGE_SIZE = 50

export async function getServerAuditLog(serverId: string, query: ServerAuditQuery = {}): Promise<ServerAuditEntry[]> {
  const { data, error } = await supabase.rpc('get_server_audit_log', {
    p_server_id: serverId,
    p_before: query.before ?? null,
    p_limit: query.limit ?? AUDIT_PAGE_SIZE,
    p_action: query.action ?? null,
    p_actor_id: query.actorId ?? null,
  })
  if (error) throw new Error(error.message || 'Failed to load the audit log')
  return (data ?? []) as ServerAuditEntry[]
}
