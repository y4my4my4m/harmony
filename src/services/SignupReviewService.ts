/**
 * Signup review and bulk suspension, for instance admins and moderators
 * (20261109500001_signup_review.sql). The server admits the caller, skips staff and reports why
 * an account was left out; nothing here decides eligibility.
 */
import { supabase } from '@/supabase'

export const SIGNUPS_PAGE_SIZE = 50
/** staff_bulk_check_ids refuses more. */
export const BULK_LIMIT = 200
export const SIGNUP_GROUP_MIN_SIZE = 3

export type SignupStatus = 'all' | 'active' | 'suspended'
export type BulkAction = 'suspend' | 'unsuspend' | 'delete'

export interface SignupDay {
  day: string
  signups: number
  suspended: number
  email_domains: number
  top_domain_count: number
  peak_hour_count: number
  refused: number
  would_refuse: number
}

export interface SignupGroup {
  kind: 'email_domain' | 'first_server'
  key: string
  label: string
  size: number
  suspended: number
  /** Domain: accounts on it before the period. Server: members who joined before the period. */
  prior_count: number
  first_at: string
  last_at: string
  member_ids: string[]
  /** MX hosts of an email domain, once looked up. */
  mail_hosts: string[] | null
}

export interface RecentSignup {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  signed_up_at: string
  email_domain: string | null
  email_confirmed: boolean
  last_sign_in_at: string | null
  is_staff: boolean
  is_suspended: boolean
  suspended_at: string | null
  suspension_reason: string | null
  post_count: number
  message_count: number
  server_count: number
  owned_server_count: number
  first_server_id: string | null
  first_server_name: string | null
  first_server_after_seconds: number | null
}

export interface OwnedServer {
  id: string
  name: string
  suspended: boolean
  member_count: number
  remote_member_count: number
}

export type BulkSkipReason =
  | 'self' | 'staff' | 'remote' | 'no_sign_in' | 'deleted' | 'already_suspended' | 'not_suspended' | 'not_found'
  | 'owns_server'

export interface BulkPreviewRow {
  id: string
  username: string | null
  display_name: string | null
  avatar_url: string | null
  skip_reason: BulkSkipReason | null
  post_count: number
  message_count: number
  local_follows: number
  remote_followers: number
  owned_servers: OwnedServer[]
}

export interface BulkResult {
  batch_id: string
  suspended: boolean
  changed: { id: string; username: string }[]
  skipped: { id: string; username: string | null; reason: BulkSkipReason }[]
  sessions_revoked: number
}

export interface BulkDeleteResult {
  batch_id: string
  deleted: { id: string; username: string }[]
  skipped: { id: string; username: string | null; reason: BulkSkipReason }[]
}

export async function listSignupDays(days: number): Promise<SignupDay[]> {
  const { data, error } = await supabase.rpc('staff_signup_daily', { p_days: days })
  if (error) throw new Error(error.message)
  return (data ?? []) as SignupDay[]
}

export async function listSignupGroups(days: number): Promise<SignupGroup[]> {
  const { data, error } = await supabase.rpc('staff_signup_groups', {
    p_days: days,
    p_min_size: SIGNUP_GROUP_MIN_SIZE,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as SignupGroup[]
}

export async function listRecentSignups(options: {
  days: number
  search?: string
  status?: SignupStatus
  profileIds?: string[] | null
  offset?: number
}): Promise<{ rows: RecentSignup[]; total: number }> {
  const { data, error } = await supabase.rpc('staff_recent_signups', {
    p_days: options.days,
    p_search: options.search?.trim() || null,
    p_status: options.status ?? 'all',
    p_profile_ids: options.profileIds ?? null,
    p_limit: SIGNUPS_PAGE_SIZE,
    p_offset: options.offset ?? 0,
  })
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as (RecentSignup & { total_count: number })[]
  return { rows, total: Number(rows[0]?.total_count ?? 0) }
}

export async function previewBulkSuspend(ids: string[], suspended: boolean): Promise<BulkPreviewRow[]> {
  const { data, error } = await supabase.rpc('staff_bulk_suspend_preview', {
    p_profile_ids: ids,
    p_suspended: suspended,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as BulkPreviewRow[]
}

export async function bulkSetSuspended(ids: string[], suspended: boolean, reason: string): Promise<BulkResult> {
  const { data, error } = await supabase.rpc('staff_bulk_set_suspended', {
    p_profile_ids: ids,
    p_suspended: suspended,
    p_reason: reason,
  })
  if (error) throw new Error(error.message)
  return data as BulkResult
}

/** Instance admins only: the server refuses a moderator. */
export async function previewBulkDelete(ids: string[]): Promise<BulkPreviewRow[]> {
  const { data, error } = await supabase.rpc('admin_delete_accounts_preview', { p_profile_ids: ids })
  if (error) throw new Error(error.message)
  return (data ?? []) as BulkPreviewRow[]
}

export async function bulkDeleteAccounts(ids: string[], reason: string): Promise<BulkDeleteResult> {
  const { data, error } = await supabase.rpc('admin_delete_accounts', {
    p_profile_ids: ids,
    p_reason: reason,
  })
  if (error) throw new Error(error.message)
  return data as BulkDeleteResult
}
