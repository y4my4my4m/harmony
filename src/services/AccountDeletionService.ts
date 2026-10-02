/**
 * Self-service account deletion.
 *
 * public.delete_my_account(p_password) is the security boundary (migration
 * 20261005400001_account_security.sql): it checks the password (or a sign-in within ten
 * minutes for accounts without one), requires a TOTP verify within ten minutes for 2FA
 * accounts, refuses while the caller owns servers with other members, tombstones the
 * profile and queues the ActivityPub Delete. This service runs the client side of the
 * step-up and maps outcomes to typed results.
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { accountSecurityService, securityErrorMessage } from '@/services/AccountSecurityService'

export type DeleteAccountResult =
  | { status: 'success' }
  | { status: 'mfa_required' }
  | { status: 'password_required' }
  | { status: 'invalid_password' }
  | { status: 'reauthentication_required' }
  | { status: 'transfer_ownership_required'; servers: string[] }
  | { status: 'error'; message: string }

class AccountDeletionService {
  /** Whether the account has a verified TOTP factor (step-up needed). */
  async isMfaEnabled(): Promise<boolean> {
    try {
      const { data, error } = await supabase.auth.mfa.listFactors()
      if (error) return false
      return (data?.totp || []).some(f => f.status === 'verified')
    } catch {
      return false
    }
  }

  /** Verifies a TOTP code now; returns null on success or an error message. */
  async verifyMfaCode(code: string): Promise<string | null> {
    try {
      await accountSecurityService.stepUpWithTotp(code)
      return null
    } catch (err) {
      return securityErrorMessage(err, 'Verification failed')
    }
  }

  /**
   * Deletes the account. Call verifyMfaCode() first when isMfaEnabled(). On success the
   * auth user no longer exists; callers sign out and clear local state.
   */
  async deleteAccount(password?: string): Promise<DeleteAccountResult> {
    try {
      const { data, error } = await supabase.rpc('delete_my_account', { p_password: password ?? null })
      if (error) {
        debug.error('delete_my_account failed:', error)
        return { status: 'error', message: securityErrorMessage(error, 'Deletion failed') }
      }

      const result = data as { success?: boolean; error?: string; servers?: string[] } | null
      if (result?.success) return { status: 'success' }
      switch (result?.error) {
        case 'mfa_required':
        case 'password_required':
        case 'invalid_password':
        case 'reauthentication_required':
          return { status: result.error }
        case 'transfer_ownership_required':
          return { status: 'transfer_ownership_required', servers: result.servers || [] }
        default:
          return { status: 'error', message: result?.error || 'Unknown error' }
      }
    } catch (err) {
      debug.error('delete_my_account threw:', err)
      return { status: 'error', message: securityErrorMessage(err, 'Deletion failed') }
    }
  }
}

export const accountDeletionService = new AccountDeletionService()
