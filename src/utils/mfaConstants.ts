/**
 * Recovery-code length bounds, shared by every MFA entry point.
 *
 * Enrolment generates 5 random bytes rendered as 10 uppercase hex characters
 * (PrivacySettings.vue). Codes issued before 2026-06 are 8 characters. Both are
 * stored as a SHA-256 of the full string, so input must not be truncated:
 * `redeem_recovery_code_and_disable_mfa` and `verify_recovery_code` rehash
 * whatever they are given and reject anything under 8 characters.
 */
export const RECOVERY_CODE_MIN_LENGTH = 8
export const RECOVERY_CODE_MAX_LENGTH = 10

/** Placeholder sized to the current code length. */
export const RECOVERY_CODE_PLACEHOLDER = 'X'.repeat(RECOVERY_CODE_MAX_LENGTH)
