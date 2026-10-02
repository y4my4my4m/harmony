/**
 * Reaction limits, enforced by the database (20261007200001_reactions_favourites_limits.sql)
 * and shown by the emoji picker.
 *
 *   message  at most MESSAGE_REACTION_KINDS different emoji, any number per person
 *            (check_message_emoji_reaction_limit; Discord's rule)
 *   post     at most instance_config max_post_reactions_per_user different emoji per person
 *            (check_emoji_reaction_limit). The heart is the favourite and is not counted.
 */

import { isHeartEmoji } from '@/utils/heartReaction'

export const MESSAGE_REACTION_KINDS = 20

export const DEFAULT_POST_REACTIONS_PER_USER = 10

/** The emoji the picker emits: a uuid `id` for an emojis row, else the unicode character. */
export interface PickedEmoji {
  id?: string
  native?: string
  name?: string
  url?: string
}

/** True for the server's REACTION_LIMIT refusal (SQLSTATE 23514), as an error or a reason string. */
export function isReactionLimitError(error: unknown): boolean {
  if (!error) return false
  const text = typeof error === 'string'
    ? error
    : String((error as { message?: unknown }).message ?? '')
  return text.includes('REACTION_LIMIT')
}

/**
 * A message holding MESSAGE_REACTION_KINDS chips takes no new emoji; adding to a held chip
 * still works. `matches` is the chip identity the reactions store toggles by.
 */
export function messageEmojiBlocked<G>(
  groups: readonly G[],
  emoji: PickedEmoji,
  matches: (group: G, emojiId: string) => boolean,
): boolean {
  if (groups.length < MESSAGE_REACTION_KINDS) return false
  const id = emoji.id || emoji.native || ''
  return !groups.some((g) => matches(g, id))
}

interface PostGroup {
  current_user_reacted: boolean
  custom_emoji_content?: string | null
  emoji_url?: string | null
}

/** The current user's reaction chips on a post, the heart left out. */
export function ownPostReactions<G extends PostGroup>(groups: readonly G[]): G[] {
  return groups.filter((g) =>
    g.current_user_reacted && !isHeartEmoji({ native: g.custom_emoji_content, url: g.emoji_url }))
}

/**
 * At `limit` reactions the person can pick only emoji they hold, which removes them, and
 * the heart.
 */
export function postEmojiBlocked<G extends PostGroup>(
  groups: readonly G[],
  emoji: PickedEmoji,
  limit: number,
  matches: (group: G, emoji: PickedEmoji) => boolean,
): boolean {
  if (isHeartEmoji(emoji)) return false
  const own = ownPostReactions(groups)
  if (own.length < limit) return false
  return !own.some((g) => matches(g, emoji))
}
