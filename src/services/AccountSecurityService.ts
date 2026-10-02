/**
 * Sessions, recovery codes, step-up and data export for the security settings.
 *
 * The database is the boundary (migration 20261005400001_account_security.sql): every RPC
 * binds to the caller, PostgREST refuses an aal1 session of a 2FA account before any of
 * them runs, and recovery-code checks and exports are rate-limited server-side.
 */

import { supabase } from '@/supabase'
import { authErrorMessage } from '@/utils/authErrorMessage'
import { i18n } from '@/i18n'

export interface AccountSession {
  id: string
  created_at: string
  last_active_at: string | null
  user_agent: string | null
  ip: string | null
  aal: string | null
  is_current: boolean
  push_transports: string[]
}

export interface RecoveryStatus {
  mfa_enabled: boolean
  total: number
  remaining: number
  generated_at: string | null
}

interface ErrorLike {
  code?: string
  error_code?: string
  message?: string
  details?: string
  status?: number
}

/** Seconds from a `retry_after=<n>` detail, as raised by the attempt budget and export limit. */
export function retryAfterSeconds(error: unknown): number | null {
  const details = (error as ErrorLike | null)?.details
  const match = typeof details === 'string' ? /retry_after=(\d+)/.exec(details) : null
  return match ? Number(match[1]) : null
}

type WaitKey = 'tooManyAttempts' | 'exportRateLimited'

/** Message keys security.errors.<base>{Soon,Minutes,Hours}. */
function waitMessage(base: WaitKey, seconds: number | null): string {
  const t = i18n.global.t
  if (!seconds) return t(`security.errors.${base}Soon`)
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  if (minutes >= 90) {
    const hours = Math.round(minutes / 60)
    return t(`security.errors.${base}Hours`, { count: hours })
  }
  return t(`security.errors.${base}Minutes`, { count: minutes }, minutes)
}

/** User-facing text for errors from the account-security RPCs and GoTrue's MFA endpoints. */
export function securityErrorMessage(error: unknown, fallback?: string): string {
  const t = i18n.global.t
  const err = (error ?? {}) as ErrorLike
  const code = err.error_code || err.code || ''
  const message = err.message || ''

  if (message === 'too_many_attempts') return waitMessage('tooManyAttempts', retryAfterSeconds(error))
  if (message === 'export_rate_limited') return waitMessage('exportRateLimited', retryAfterSeconds(error))
  if (message === 'export_expired') return t('security.errors.exportExpired')
  if (message === 'step_up_required') return t('security.errors.stepUpRequired')
  if (message === 'insufficient_aal' || code === 'insufficient_aal') {
    return t('security.errors.insufficientAal')
  }
  if (message === 'session_revoked' || code === 'session_not_found') {
    return t('security.errors.sessionRevoked')
  }
  if (code === 'mfa_verification_failed' || /invalid totp code/i.test(message)) {
    return t('security.errors.codeMismatch')
  }
  if (code === 'mfa_challenge_expired') return t('security.errors.challengeExpired')
  if (code === 'over_request_rate_limit' || err.status === 429) {
    return t('security.errors.rateLimited')
  }
  return authErrorMessage(error, fallback ?? t('security.errors.generic'))
}

async function verifiedTotpFactorId(): Promise<string> {
  const { data, error } = await supabase.auth.mfa.listFactors()
  if (error) throw error
  const factor = (data?.totp ?? []).find((f) => f.status === 'verified')
  if (!factor) throw new Error(i18n.global.t('security.errors.mfaNotEnabled'))
  return factor.id
}

export const accountSecurityService = {
  async listSessions(): Promise<AccountSession[]> {
    const { data, error } = await supabase.rpc('list_my_sessions')
    if (error) throw error
    return (data ?? []) as AccountSession[]
  },

  async revokeSession(sessionId: string): Promise<boolean> {
    const { data, error } = await supabase.rpc('revoke_my_session', { p_session_id: sessionId })
    if (error) throw error
    return data === true
  },

  /** GoTrue's own logout scope; the current session stays signed in. */
  async signOutOtherSessions(): Promise<void> {
    const { error } = await supabase.auth.signOut({ scope: 'others' })
    if (error) throw error
  },

  /** Current-password check for the password form; shares the server's attempt budget. */
  async verifyPassword(password: string): Promise<boolean> {
    const { data, error } = await supabase.rpc('verify_my_password', { p_password: password })
    if (error) throw error
    return data === true
  },

  async getRecoveryStatus(): Promise<RecoveryStatus> {
    const { data, error } = await supabase.rpc('get_mfa_recovery_status')
    if (error) throw error
    return data as RecoveryStatus
  },

  /** Ten new codes; earlier ones stop working. Needs stepUpWithTotp within ten minutes. */
  async generateRecoveryCodes(): Promise<string[]> {
    const { data, error } = await supabase.rpc('generate_mfa_recovery_codes')
    if (error) throw error
    return (data ?? []) as string[]
  },

  /** Verifies a TOTP code against the enrolled factor, refreshing the session's step-up time. */
  async stepUpWithTotp(code: string): Promise<void> {
    const factorId = await verifiedTotpFactorId()
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code })
    if (error) throw error
  },
}

export function recoveryCodesText(codes: string[], account: string): string {
  return [
    'Harmony recovery codes',
    `Account: ${account}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each code signs you in once if you lose your authenticator app.',
    'Using one turns two-factor authentication off until you set it up again.',
    '',
    ...codes,
    '',
  ].join('\n')
}

/** Saves a blob through an anchor download; the webview or browser picks the location. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
