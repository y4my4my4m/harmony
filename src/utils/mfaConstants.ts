/**
 * Recovery-code input bounds, shared by every MFA entry point.
 *
 * generate_mfa_recovery_codes issues ten Crockford base32 characters shown as
 * XXXXX-XXXXX. Codes from earlier releases are 8 or 10 upper-case hex characters.
 * The database strips separators, upper-cases and maps O/I/L before hashing, so input
 * keeps whatever the user typed; the minimum counts letters and digits only.
 */
export const RECOVERY_CODE_MIN_LENGTH = 8
export const RECOVERY_CODE_MAX_LENGTH = 16

export const RECOVERY_CODE_PLACEHOLDER = 'XXXXX-XXXXX'

/** Letters and digits in a typed recovery code. */
export function recoveryCodeLength(code: string): number {
  return code.replace(/[^0-9A-Za-z]/g, '').length
}
