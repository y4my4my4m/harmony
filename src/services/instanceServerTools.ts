/**
 * This instance's tools for chat servers hosted on other instances (migration
 * 20261027300001): block a server, hide its media, remove local members and keep them out.
 * Each acts on this instance only. Instance admins and moderators; the RPCs check the caller.
 */
import { supabase } from '@/supabase'

export interface RemoteServerState {
  server_id: string
  name: string
  icon: string | null
  host: string | null
  ap_id: string | null
  /** Accepted members whose account is on this instance. */
  local_members: number
  blocked: boolean
  media_hidden: boolean
  /** The block's reason; staff only. */
  reason: string | null
  set_by: string | null
  set_at: string | null
  kept_out: number
}

export interface RemoteServerPerson {
  profile_id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  standing: 'accepted' | 'pending' | 'kept_out'
  reason: string | null
  set_at: string | null
  /** An admin or moderator of this instance; a moderator does not remove them. */
  is_instance_staff: boolean
}

export interface BlockResult {
  blocked: boolean
  members_removed: number
}

export interface RemoveResult {
  removed: boolean
  kept_out: boolean
}

export async function listRemoteServers(): Promise<RemoteServerState[]> {
  const { data, error } = await supabase.rpc('instance_remote_servers', {})
  if (error) throw error
  return (data ?? []) as RemoteServerState[]
}

export async function getRemoteServer(serverId: string): Promise<RemoteServerState | null> {
  const { data, error } = await supabase.rpc('instance_remote_servers', { p_server_id: serverId })
  if (error) throw error
  return ((data ?? []) as RemoteServerState[])[0] ?? null
}

// instance_remote_server_people carries no staff flags; they are read from this instance's staff,
// a short list, instead of from every person.
export async function getRemoteServerPeople(serverId: string): Promise<RemoteServerPerson[]> {
  const [people, staff] = await Promise.all([
    supabase.rpc('instance_remote_server_people', { p_server_id: serverId }),
    supabase.from('profiles').select('id').eq('is_local', true).or('is_admin.eq.true,is_moderator.eq.true'),
  ])
  if (people.error) throw people.error
  if (staff.error) throw staff.error
  const staffIds = new Set(((staff.data ?? []) as Array<{ id: string }>).map((row) => row.id))
  return ((people.data ?? []) as Array<Omit<RemoteServerPerson, 'is_instance_staff'>>)
    .map((person) => ({ ...person, is_instance_staff: staffIds.has(person.profile_id) }))
}

export async function setServerBlocked(serverId: string, blocked: boolean, reason?: string): Promise<BlockResult> {
  const { data, error } = await supabase.rpc('instance_set_server_blocked', {
    p_server_id: serverId,
    p_blocked: blocked,
    p_reason: reason?.trim() || null,
  })
  if (error) throw error
  return data as BlockResult
}

export async function setServerMediaHidden(serverId: string, hidden: boolean): Promise<boolean> {
  const { data, error } = await supabase.rpc('instance_set_server_media_hidden', {
    p_server_id: serverId,
    p_hidden: hidden,
  })
  if (error) throw error
  return data === true
}

export async function removeMemberHere(
  serverId: string,
  profileId: string,
  keepOut: boolean,
  reason?: string,
): Promise<RemoveResult> {
  const { data, error } = await supabase.rpc('instance_remove_member', {
    p_server_id: serverId,
    p_profile_id: profileId,
    p_keep_out: keepOut,
    p_reason: reason?.trim() || null,
  })
  if (error) throw error
  return data as RemoveResult
}

export async function liftKeepout(serverId: string, profileId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('instance_lift_keepout', {
    p_server_id: serverId,
    p_profile_id: profileId,
  })
  if (error) throw error
  return data === true
}

export async function fetchMediaHiddenServerIds(): Promise<string[]> {
  const { data, error } = await supabase.rpc('instance_media_hidden_servers')
  if (error) throw error
  return ((data ?? []) as unknown[]).filter((id): id is string => typeof id === 'string')
}
