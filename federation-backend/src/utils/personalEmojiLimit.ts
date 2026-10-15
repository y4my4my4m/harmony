/**
 * instance_config max_personal_emojis_per_user, enforced on every user-scope emojis row by
 * enforce_personal_emoji_limit (20261016100004_personal_emoji_uploads.sql). AI-generated
 * personal emojis count toward it.
 */

/** The limit a PERSONAL_EMOJI_LIMIT refusal (SQLSTATE 23514) names; null for any other error. */
export function personalEmojiLimitOf(error: { code?: string; message?: string } | null | undefined): number | null {
  if (error?.code !== '23514') return null;
  const match = /PERSONAL_EMOJI_LIMIT: at most (\d+)/.exec(error.message ?? '');
  return match ? Number(match[1]) : null;
}

/** User-facing refusal for a full personal emoji library; 0 is personal emojis off. */
export function personalEmojiLimitMessage(limit: number): string {
  if (limit <= 0) return 'Personal emojis are turned off on this instance.';
  return `You have reached this instance's limit of ${limit} personal emojis. Delete one in Settings > My emojis to make room.`;
}
