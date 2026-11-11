/**
 * Account migration: aliases, moving to another account and cancelling the redirect.
 *
 * The federation backend's /account routes resolve handles (WebFinger and a fresh actor
 * fetch for remote accounts) and call set_my_account_aliases, begin_account_move and
 * cancel_my_account_redirect with the caller's token (migration
 * 20261010900001_account_migration.sql). begin_account_move re-authenticates as
 * delete_my_account does; for 2FA accounts call verifyMfaCode() first, which refreshes the
 * session's step-up time.
 *
 * Following import runs in a worker through the RPCs of 20261109700001_following_import.sql.
 * POST /account/profile/copy copies the profile of an account that moved here.
 */

import { supabase } from '@/supabase'
import { apiUrl } from '@/services/instanceConfig'
import { debug } from '@/utils/debug'
import { accountDeletionService } from '@/services/AccountDeletionService'
import { accountRefsForUris, resolveMoveTarget, type AccountRef } from '@/utils/movedAccount'
import type { FollowingImportSource } from '@/utils/followingImportFile'

export interface MigrationAccount {
  id: string
  username: string
  domain: string | null
  is_local: boolean
  display_name: string | null
  avatar_url: string | null
  uri: string
  locked: boolean
}

/** Fields the old account's profile can give; avatar and banner are stored again under this account. */
export type ProfileCopyField = 'display_name' | 'bio' | 'avatar' | 'banner' | 'profile_fields'

export interface ProfileValues {
  display_name: string | null
  bio: string | null
  avatar_url: string | null
  banner_url: string | null
  profile_fields: Array<{ name: string; value: string }>
}

/** An account whose move to this one both sides confirm. */
export interface MovedOrigin extends ProfileValues {
  id: string
  handle: string
}

export interface FollowingImport {
  id: string
  source: FollowingImportSource
  total: number
  created_at: string
  finished_at: string | null
  cancelled: boolean
  /** Seconds until the follow limit lets it continue; null when it is not waiting on that. */
  retry_after: number | null
  counts: {
    followed: number
    requested: number
    already_following: number
    already_requested: number
    failed: number
    cancelled: number
  }
  failures: Array<{ handle: string; reason: string }>
}

export interface MigrationState {
  profileId: string
  /** This account's actor URI, as the other account lists it. */
  actorUri: string
  /** @user@domain, as typed on another instance. */
  handle: string
  aliases: AccountRef[]
  movedTo: AccountRef | null
  movedAt: string | null
  ownedServers: string[]
  /** This account's own profile, as a copy would replace it. */
  profile: ProfileValues
  movedFrom: MovedOrigin[]
}

export interface MovePreview {
  target: MigrationAccount
  isSelf: boolean
  aliasConfirmed: boolean
  targetMoved: boolean
  aliasUri: string
}

export type MigrationFailure = { ok: false; error: string; retryAfter?: number }
export type MigrationResult<T> = ({ ok: true } & T) | MigrationFailure

async function call<T>(method: 'POST' | 'DELETE', path: string, body?: Record<string, unknown>): Promise<MigrationResult<T>> {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) return { ok: false, error: 'not_authenticated' }
    const response = await fetch(apiUrl(`/api/federation/account${path}`), {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = await response.json().catch(() => ({}))
    if (!response.ok) {
      const retryAfter = typeof json.retry_after === 'number'
        ? json.retry_after
        : typeof json.retryAfter === 'number' ? json.retryAfter : undefined
      return { ok: false, error: typeof json.error === 'string' ? json.error : `http_${response.status}`, retryAfter }
    }
    return { ok: true, ...(json as T) }
  } catch (err) {
    debug.error(`account migration ${path} failed:`, err)
    return { ok: false, error: 'network_error' }
  }
}

class AccountMigrationService {
  /** The signed-in account's aliases, redirect and owned servers. */
  async loadState(): Promise<MigrationState | null> {
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) return null

    const { data: me, error } = await supabase
      .from('profiles')
      .select('id, username, domain, federated_id, also_known_as, moved_to_id, moved_to_uri, moved_at, display_name, bio, avatar_url, banner_url, profile_fields')
      .eq('auth_user_id', uid)
      .maybeSingle()
    if (error || !me) {
      if (error) debug.error('Failed to load migration state:', error)
      return null
    }

    const aliasUris: string[] = Array.isArray(me.also_known_as) ? me.also_known_as : []
    const [aliases, movedTo, owned, movedHere] = await Promise.all([
      accountRefsForUris(aliasUris),
      resolveMoveTarget(me.moved_to_id, me.moved_to_uri),
      supabase.from('servers').select('name').eq('owner', me.id),
      supabase
        .from('profiles')
        .select('id, username, domain, federated_id, moved_at, display_name, bio, avatar_url, banner_url, profile_fields')
        .eq('moved_to_id', me.id)
        .order('moved_at', { ascending: false }),
    ])
    const profileValues = (row: any): ProfileValues => ({
      display_name: row.display_name ?? null,
      bio: row.bio ?? null,
      avatar_url: row.avatar_url ?? null,
      banner_url: row.banner_url ?? null,
      profile_fields: Array.isArray(row.profile_fields) ? row.profile_fields : [],
    })

    return {
      profileId: me.id,
      actorUri: me.federated_id || `https://${me.domain}/users/${me.username}`,
      handle: `@${me.username}@${me.domain}`,
      aliases,
      movedTo,
      movedAt: me.moved_at ?? null,
      ownedServers: ((owned.data ?? []) as Array<{ name: string }>).map((s) => s.name),
      profile: profileValues(me),
      movedFrom: (movedHere.data ?? [])
        .filter((row: any) => aliasUris.includes(row.federated_id || `https://${row.domain}/users/${row.username}`))
        .map((row: any) => ({ ...profileValues(row), id: row.id, handle: `@${row.username}@${row.domain}` })),
    }
  }

  addAlias(handle: string): Promise<MigrationResult<{ aliases: string[] }>> {
    return call('POST', '/aliases', { handle })
  }

  removeAlias(uri: string): Promise<MigrationResult<{ aliases: string[] }>> {
    return call('DELETE', '/aliases', { uri })
  }

  async previewMove(handle: string): Promise<MigrationResult<{ preview: MovePreview }>> {
    const result = await call<{ target: MigrationAccount; is_self: boolean; alias_confirmed: boolean; target_moved: boolean; alias_uri: string }>(
      'POST', '/move/preview', { handle })
    if (!result.ok) return result
    return {
      ok: true,
      preview: {
        target: result.target,
        isSelf: result.is_self,
        aliasConfirmed: result.alias_confirmed,
        targetMoved: result.target_moved,
        aliasUri: result.alias_uri,
      },
    }
  }

  moveAccount(handle: string, password?: string): Promise<MigrationResult<{ migration_id: string; target: MigrationAccount }>> {
    return call('POST', '/move', { handle, password: password ?? null })
  }

  cancelRedirect(): Promise<MigrationResult<Record<string, never>>> {
    return call('POST', '/move/cancel')
  }

  /** Queues a follow of each handle. Errors as start_following_import returns them. */
  async startFollowingImport(handles: string[], source: FollowingImportSource): Promise<MigrationResult<{ total: number }>> {
    const { data, error } = await supabase.rpc('start_following_import', { p_handles: handles, p_source: source })
    if (error) {
      debug.error('start_following_import failed:', error)
      const retryAfter = Number(/retry_after=(\d+)/.exec(error.details ?? '')?.[1]) || undefined
      return { ok: false, error: error.code === 'PT429' ? error.message : 'generic', retryAfter }
    }
    if (data?.error) return { ok: false, error: data.error }
    return { ok: true, total: data?.total ?? handles.length }
  }

  /** The account's latest import; null when it has none or the read failed. */
  async getFollowingImport(): Promise<FollowingImport | null> {
    const { data, error } = await supabase.rpc('get_my_following_import')
    if (error) {
      debug.error('get_my_following_import failed:', error)
      return null
    }
    return (data as FollowingImport | null) ?? null
  }

  async cancelFollowingImport(): Promise<MigrationResult<Record<string, never>>> {
    const { data, error } = await supabase.rpc('cancel_my_following_import')
    if (error) {
      debug.error('cancel_my_following_import failed:', error)
      return { ok: false, error: 'generic' }
    }
    if (data?.error) return { ok: false, error: data.error }
    return { ok: true } as MigrationResult<Record<string, never>>
  }

  /** `update` holds the stored values; `failed` the images that could not be read. */
  copyProfile(originId: string, fields: ProfileCopyField[]): Promise<MigrationResult<{
    copied: ProfileCopyField[]
    failed: ProfileCopyField[]
    update: Partial<ProfileValues>
  }>> {
    return call('POST', '/profile/copy', { origin_id: originId, fields })
  }

  isMfaEnabled(): Promise<boolean> {
    return accountDeletionService.isMfaEnabled()
  }

  verifyMfaCode(code: string): Promise<string | null> {
    return accountDeletionService.verifyMfaCode(code)
  }
}

export const accountMigrationService = new AccountMigrationService()
