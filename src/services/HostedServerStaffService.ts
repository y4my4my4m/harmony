/**
 * Trust & Safety on servers hosted on this instance, for instance admins and moderators
 * (20261027250001_instance_staff_safety.sql). Every write is taken as instance staff and
 * recorded in the server's audit log; a deletion is recorded in admin_audit_log only.
 */
import { supabase } from '@/supabase'

export interface HostedServer {
  id: string
  name: string
  icon: string | null
  public: boolean | null
  federation_enabled: boolean | null
  created_at: string
  owner_id: string | null
  owner_username: string | null
  owner_display_name: string | null
  owner_avatar_url: string | null
  member_count: number
  remote_member_count: number
  suspended_at: string | null
  suspended_reason: string | null
  suspended_by_username: string | null
}

export interface HostedServerMember {
  user_id: string
  username: string | null
  display_name: string | null
  avatar_url: string | null
  domain: string | null
  is_local: boolean
  status: 'accepted' | 'pending' | string
  joined_at: string
  is_owner: boolean
  is_instance_staff: boolean
}

export interface HostedServerChannel {
  id: string
  name: string
  /** 0 text, 1 voice, 2 category; voice channels carry text too. */
  type: number
  category_name: string | null
  position: number | null
}

export interface HostedServerMessage {
  id: string
  channel_id: string
  channel_name: string
  thread_id: string | null
  user_id: string | null
  bot_id: string | null
  author_username: string | null
  author_display_name: string | null
  author_avatar_url: string | null
  author_domain: string | null
  /** Null for an end-to-end encrypted message. */
  content: unknown
  encrypted: boolean
  created_at: string
}

export interface Page<T> {
  rows: T[]
  total: number
}

/** The database caps a page at 100. */
export const STAFF_PAGE_SIZE = 25
export const STAFF_MESSAGE_PAGE_SIZE = 50

function fail(error: { message?: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback)
}

function paged<T extends { total_count?: number | string }>(data: T[] | null): Page<Omit<T, 'total_count'>> {
  const rows = (data ?? []).map(({ total_count: _total, ...row }) => row)
  return { rows, total: Number(data?.[0]?.total_count ?? 0) }
}

export async function listHostedServers(
  query: { search?: string; suspendedOnly?: boolean; offset?: number; limit?: number } = {},
): Promise<Page<HostedServer>> {
  const { data, error } = await supabase.rpc('staff_hosted_servers', {
    p_search: query.search?.trim() || null,
    p_suspended_only: query.suspendedOnly ?? false,
    p_limit: query.limit ?? STAFF_PAGE_SIZE,
    p_offset: query.offset ?? 0,
  })
  if (error) fail(error, 'Failed to load the servers')
  return paged(data as Array<HostedServer & { total_count: number }>)
}

export async function listServerMembers(
  serverId: string,
  query: { search?: string; offset?: number; limit?: number } = {},
): Promise<Page<HostedServerMember>> {
  const { data, error } = await supabase.rpc('staff_server_members', {
    p_server_id: serverId,
    p_search: query.search?.trim() || null,
    p_limit: query.limit ?? STAFF_PAGE_SIZE,
    p_offset: query.offset ?? 0,
  })
  if (error) fail(error, 'Failed to load the members')
  return paged(data as Array<HostedServerMember & { total_count: number }>)
}

export async function listServerChannels(serverId: string): Promise<HostedServerChannel[]> {
  const { data, error } = await supabase.rpc('staff_server_channels', { p_server_id: serverId })
  if (error) fail(error, 'Failed to load the channels')
  return (data ?? []) as HostedServerChannel[]
}

/** Newest first, in one channel or by one author; `before` is the oldest created_at shown. */
export async function listServerMessages(
  serverId: string,
  query: { channelId?: string | null; authorId?: string | null; before?: string | null; limit?: number },
): Promise<HostedServerMessage[]> {
  const { data, error } = await supabase.rpc('staff_server_messages', {
    p_server_id: serverId,
    p_channel_id: query.channelId ?? null,
    p_author_id: query.authorId ?? null,
    p_before: query.before ?? null,
    p_limit: query.limit ?? STAFF_MESSAGE_PAGE_SIZE,
  })
  if (error) fail(error, 'Failed to load the messages')
  return (data ?? []) as HostedServerMessage[]
}

export async function staffRemoveMember(
  serverId: string,
  profileId: string,
  options: { ban: boolean; reason?: string | null },
): Promise<void> {
  const { error } = await supabase.rpc('staff_remove_member', {
    p_server_id: serverId,
    p_profile_id: profileId,
    p_ban: options.ban,
    p_reason: options.reason?.trim() || null,
  })
  if (error) fail(error, 'Failed to remove the member')
}

export async function staffRemoveMessage(messageId: string, reason?: string | null): Promise<void> {
  const { error } = await supabase.rpc('staff_remove_message', {
    p_message_id: messageId,
    p_reason: reason?.trim() || null,
  })
  if (error) fail(error, 'Failed to remove the message')
}

export async function staffSetServerSuspended(
  serverId: string,
  suspended: boolean,
  reason?: string | null,
): Promise<{ suspended_at: string | null; suspended_reason: string | null }> {
  const { data, error } = await supabase.rpc('staff_set_server_suspended', {
    p_server_id: serverId,
    p_suspended: suspended,
    p_reason: reason?.trim() || null,
  })
  if (error) fail(error, 'Failed to change the suspension')
  const result = (data ?? {}) as { suspended_at?: string | null; suspended_reason?: string | null }
  return { suspended_at: result.suspended_at ?? null, suspended_reason: result.suspended_reason ?? null }
}

export async function staffDeleteServer(serverId: string, reason?: string | null): Promise<void> {
  const { error } = await supabase.rpc('staff_delete_server', {
    p_server_id: serverId,
    p_reason: reason?.trim() || null,
  })
  if (error) fail(error, 'Failed to delete the server')
}
