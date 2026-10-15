/**
 * Personal emoji limit: instance_config max_personal_emojis_per_user, enforced on every
 * user-scope emojis row, AI-generated included (20261016100004_personal_emoji_uploads.sql,
 * enforce_personal_emoji_limit).
 */

export const DEFAULT_PERSONAL_EMOJIS_PER_USER = 50
export const MAX_PERSONAL_EMOJIS_PER_USER = 1000

/** Mirrors personal_emoji_limit(): 0 turns personal emojis off; above 1000 reads as 1000; anything else unusable as 50. */
export function parsePersonalEmojiLimit(value: unknown): number {
  const num = typeof value === 'number' ? value : parseInt(String(value), 10)
  if (num === 0) return 0
  if (!Number.isInteger(num) || num < 1) return DEFAULT_PERSONAL_EMOJIS_PER_USER
  return Math.min(num, MAX_PERSONAL_EMOJIS_PER_USER)
}

/** The limit a PERSONAL_EMOJI_LIMIT refusal (SQLSTATE 23514) names; null for any other error. */
export function personalEmojiLimitOf(error: unknown): number | null {
  const e = error as { code?: string; message?: string } | null
  if (e?.code !== '23514') return null
  const match = /PERSONAL_EMOJI_LIMIT: at most (\d+)/.exec(e.message ?? '')
  return match ? Number(match[1]) : null
}
