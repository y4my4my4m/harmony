/**
 * Self-service account deletion.
 *
 * The server-side `delete_my_account` RPC is the security boundary: it
 * enforces the MFA step-up (aal2) itself and refuses while the caller still
 * owns servers with other members. This service handles the client side of
 * the step-up (TOTP challenge/verify to elevate the session to aal2) and
 * maps RPC outcomes to typed results for the settings UI.
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

export type DeleteAccountResult =
  | { status: 'success' }
  | { status: 'mfa_required' }
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

  /**
   * Elevate the current session to aal2 with a TOTP code.
   * Returns null on success, or an error message.
   */
  async verifyMfaCode(code: string): Promise<string | null> {
    try {
      const { data: factorData, error: listError } = await supabase.auth.mfa.listFactors()
      if (listError) return listError.message

      const factor = (factorData?.totp || []).find(f => f.status === 'verified')
      if (!factor) return 'No verified authenticator found'

      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: factor.id,
      })
      if (challengeError || !challenge) return challengeError?.message || 'Failed to start verification'

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: factor.id,
        challengeId: challenge.id,
        code,
      })
      if (verifyError) return 'Invalid verification code'

      return null
    } catch (err: any) {
      return err?.message || 'Verification failed'
    }
  }

  /**
   * Delete the account. Call verifyMfaCode() first when isMfaEnabled().
   * On success the auth user no longer exists - callers must sign out and
   * clear all local state immediately.
   */
  async deleteAccount(): Promise<DeleteAccountResult> {
    try {
      const { data, error } = await supabase.rpc('delete_my_account')

      if (error) {
        debug.error('delete_my_account failed:', error)
        return { status: 'error', message: error.message }
      }

      const result = data as { success?: boolean; error?: string; servers?: string[] } | null
      if (result?.success) return { status: 'success' }
      if (result?.error === 'mfa_required') return { status: 'mfa_required' }
      if (result?.error === 'transfer_ownership_required') {
        return { status: 'transfer_ownership_required', servers: result.servers || [] }
      }
      return { status: 'error', message: result?.error || 'Unknown error' }
    } catch (err: any) {
      debug.error('delete_my_account threw:', err)
      return { status: 'error', message: err?.message || 'Deletion failed' }
    }
  }
}

export const accountDeletionService = new AccountDeletionService()
