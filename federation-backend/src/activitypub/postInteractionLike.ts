/**
 * Outbound Like for a post_interactions row, shared by the queue handler and the legacy
 * CDC listener so a favourite and its Undo carry the same shape on both paths.
 */

import { createLikeActivity, likeActivityId } from './converters/toActivityPub.js';
import { resolveOutboundEmoji } from '../utils/emojiResolvers.js';
import { isHeartReaction } from '../utils/heartReaction.js';

export interface PostInteractionRef {
  interaction_id: string;
  interaction_type: string;
  emoji_id?: string | null;
  custom_emoji_content?: string | null;
}

/** Interaction types federated as a Like. A reblog is the Announce of its boost post. */
export function isLikeInteraction(interactionType: string | null | undefined): boolean {
  return interactionType === 'favorite' || interactionType === 'emoji_reaction';
}

/**
 * True for a row federated as a bare Like: the favourite, and an emoji_reaction carrying a
 * unicode heart or no emoji at all. The last two exist only in jobs queued before
 * trg_fold_heart_reaction and before the delete payload carried the emoji.
 */
export function isFavouriteInteraction(ref: PostInteractionRef): boolean {
  if (ref.interaction_type === 'favorite') return true;
  if (ref.emoji_id) return false;
  return !ref.custom_emoji_content || isHeartReaction(ref.custom_emoji_content);
}

/**
 * @param targetDomain - Domain of the post author's instance; an emoji native to it is sent
 *   as `:name:`. See resolveOutboundEmoji.
 */
export async function buildPostInteractionLike(
  user: { username: string },
  postApId: string,
  ref: PostInteractionRef,
  targetDomain?: string,
  recipientUrls?: string[],
): Promise<any> {
  const id = likeActivityId(user, ref.interaction_id);
  if (isFavouriteInteraction(ref)) {
    return createLikeActivity(user, postApId, undefined, undefined, recipientUrls, id);
  }
  const { content, emojiData } = await resolveOutboundEmoji(ref.emoji_id, ref.custom_emoji_content, targetDomain);
  return createLikeActivity(user, postApId, content, emojiData ?? undefined, recipientUrls, id);
}
