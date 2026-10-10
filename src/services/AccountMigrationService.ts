/**
 * Account migration: aliases, moving to another account and cancelling the redirect.
 *
 * The federation backend's /account routes resolve handles (WebFinger and a fresh actor
 * fetch for remote accounts) and call set_my_account_aliases, begin_account_move and
 * cancel_my_account_redirect with the caller's token (migration
 * 20261010900001_account_migration.sql). begin_account_move re-authenticates as
 * delete_my_account does; for 2FA accounts call verifyMfaCode() first, which refreshes the
 * session's step-up time.
 */

import { supabase } from '@/supabase'
import { apiUrl } from '@/services/instanceConfig'
import { debug } from '@/utils/debug'
import { accountDeletionService } from '@/services/AccountDeletionService'
import { accountRefsForUris, resolveMoveTarget, type AccountRef } from '@/utils/movedAccount'

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
      .select('id, username, domain, federated_id, also_known_as, moved_to_id, moved_to_uri, moved_at')
      .eq('auth_user_id', uid)
      .maybeSingle()
    if (error || !me) {
      if (error) debug.error('Failed to load migration state:', error)
      return null
    }

    const [aliases, movedTo, owned] = await Promise.all([
      accountRefsForUris(Array.isArray(me.also_known_as) ? me.also_known_as : []),
      resolveMoveTarget(me.moved_to_id, me.moved_to_uri),
      supabase.from('servers').select('name').eq('owner', me.id),
    ])

    return {
      profileId: me.id,
      actorUri: me.federated_id || `https://${me.domain}/users/${me.username}`,
      handle: `@${me.username}@${me.domain}`,
      aliases,
      movedTo,
      movedAt: me.moved_at ?? null,
      ownedServers: ((owned.data ?? []) as Array<{ name: string }>).map((s) => s.name),
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

  isMfaEnabled(): Promise<boolean> {
    return accountDeletionService.isMfaEnabled()
  }

  verifyMfaCode(code: string): Promise<string | null> {
    return accountDeletionService.verifyMfaCode(code)
  }
}

export const accountMigrationService = new AccountMigrationService()
