// Server members by range, by search and by id (20261113100001_member_directory.sql).
//
// Each call answers one JSON row, so a PostgREST row cap cuts none of them. An instance
// without the functions answers PGRST202; the directory then reads as unavailable for the
// session and callers take the paged table reads.

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

/** A member as get_server_member_list and search_server_members answer it; null columns are absent. */
export interface DirectoryMember {
  id: string
  /** Sidebar group: role:<id>, online, away, busy, federated or offline. Absent in search results. */
  group?: string | null
  username?: string | null
  web_handle?: string | null
  display_name?: string | null
  avatar_url?: string | null
  banner_url?: string | null
  bio?: string | null
  color?: string | null
  /** profiles.status: the manual choice. */
  status?: number | null
  domain?: string | null
  updated_at?: string | null
  created_at?: string | null
  is_local?: boolean | null
  custom_status?: unknown
  is_admin?: boolean | null
  is_moderator?: boolean | null
  instance_role?: string | null
  /** Presence as the caller sees it. */
  online: boolean
  presence_status: number
  is_mobile: boolean
  /** Roles on the server, highest first, default role left out. */
  role_ids: string[]
}

export interface MemberGroupCount {
  key: string
  count: number
}

export interface MemberListPage {
  total: number
  offset: number
  groups: MemberGroupCount[]
  members: DirectoryMember[]
  /**
   * presence:update reaches server-presence:<server> for this server. False for a server too
   * large for it: its list is read again on a timer.
   */
  live: boolean
  /** How old the order answered may be, ms; 0 for an answer computed for this call. */
  maxAgeMs: number
}

/** get_server_member_list's largest page. */
export const MEMBER_PAGE_MAX = 200

/** get_server_member_roles' largest id list. */
export const MEMBER_ROLES_MAX = 200

let missing = false

/** No call has found the member directory functions absent. */
export function memberDirectoryAvailable(): boolean {
  return !missing
}

/** Test seam: forgets a PGRST202 seen earlier. */
export function resetMemberDirectoryAvailability(): void {
  missing = false
}

// PGRST202: no function of that name and argument list in the schema cache.
function unavailable(error: { code?: string } | null): boolean {
  if (error?.code !== 'PGRST202') return false
  missing = true
  debug.warn('Member directory functions absent on this instance; using table reads')
  return true
}

/** Members [offset, offset + limit) in sidebar order with group counts. Null when unavailable. */
export async function fetchMemberPage(
  serverId: string,
  offset: number,
  limit: number,
  query?: string | null,
): Promise<MemberListPage | null> {
  if (!memberDirectoryAvailable()) return null
  const { data, error } = await supabase.rpc('get_server_member_list', {
    p_server_id: serverId,
    p_offset: offset,
    p_limit: Math.min(limit, MEMBER_PAGE_MAX),
    p_query: query?.trim() || null,
  })
  if (error) {
    if (unavailable(error)) return null
    throw error
  }
  const page = (data ?? {}) as Partial<MemberListPage> & { max_age_ms?: number | string }
  return {
    total: Number(page.total ?? 0),
    offset: Number(page.offset ?? offset),
    groups: (page.groups ?? []).map(g => ({ key: g.key, count: Number(g.count) })),
    members: page.members ?? [],
    live: page.live !== false,
    maxAgeMs: Number(page.max_age_ms ?? 0),
  }
}

/** Members whose username or display name contains `query`, best match first. Null when unavailable. */
export async function searchServerMembers(serverId: string, query: string, limit = 20): Promise<DirectoryMember[] | null> {
  if (!memberDirectoryAvailable()) return null
  const needle = query.trim()
  if (!needle) return []
  const { data, error } = await supabase.rpc('search_server_members', {
    p_server_id: serverId,
    p_query: needle,
    p_limit: limit,
  })
  if (error) {
    if (unavailable(error)) return null
    throw error
  }
  return (data ?? []) as DirectoryMember[]
}

/**
 * The members a room's Megolm session is shared with (get_room_member_id_list), whole.
 * Null when unavailable.
 */
export async function fetchRoomMemberIds(roomId: string): Promise<string[] | null> {
  if (!memberDirectoryAvailable()) return null
  const { data, error } = await supabase.rpc('get_room_member_id_list', { p_room_id: roomId })
  if (error) {
    if (unavailable(error)) return null
    throw error
  }
  return Array.isArray(data) ? data.map(String) : []
}

/** Role ids per member, default role left out; a member without roles is absent. Null when unavailable. */
export async function fetchMemberRoles(serverId: string, userIds: string[]): Promise<Record<string, string[]> | null> {
  if (!memberDirectoryAvailable()) return null
  const result: Record<string, string[]> = {}
  for (let i = 0; i < userIds.length; i += MEMBER_ROLES_MAX) {
    const { data, error } = await supabase.rpc('get_server_member_roles', {
      p_server_id: serverId,
      p_user_ids: userIds.slice(i, i + MEMBER_ROLES_MAX),
    })
    if (error) {
      if (unavailable(error)) return null
      throw error
    }
    Object.assign(result, (data ?? {}) as Record<string, string[]>)
  }
  return result
}

/** Members per role. Null when unavailable. */
export async function fetchRoleMemberCounts(serverId: string): Promise<Record<string, number> | null> {
  if (!memberDirectoryAvailable()) return null
  const { data, error } = await supabase.rpc('get_server_role_member_counts', { p_server_id: serverId })
  if (error) {
    if (unavailable(error)) return null
    throw error
  }
  const counts: Record<string, number> = {}
  for (const [roleId, n] of Object.entries((data ?? {}) as Record<string, number | string>)) counts[roleId] = Number(n)
  return counts
}
