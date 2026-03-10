/**
 * Shared emoji resolution utilities for federation reaction handlers.
 *
 * Both post reactions (DatabaseListener, reactionHandler) and channel reactions
 * (ChannelReactionHandler) need to resolve an emoji_id + custom_emoji_content
 * into an ActivityPub-compatible representation. This module centralises that
 * logic so every outbound reaction is formatted identically.
 */

import { getSupabaseClient } from '../config/supabase.js';
import { logger } from './logger.js';

export interface ResolvedEmoji {
  /** The string to put in `content` / `_misskey_reaction` — either a unicode
   *  character (e.g. "😇") or a shortcode (e.g. ":blobcat:"). */
  content: string;
  /** Non-null only for custom emojis that have an image URL. */
  emojiData: { name: string; url: string } | null;
}

/**
 * Format a pre-fetched emoji object for outbound federation.
 * Used when emoji data is already available (e.g. from a Supabase JOIN).
 */
export function formatEmojiForFederation(
  emoji: { name: string; url: string | null; domain?: string | null } | null,
  customEmojiContent: string | null | undefined,
): ResolvedEmoji {
  if (!emoji) {
    return { content: customEmojiContent || '❤', emojiData: null };
  }

  if (emoji.url) {
    const shortcode = emoji.domain
      ? `:${emoji.name}@${emoji.domain}:`
      : `:${emoji.name}:`;
    return {
      content: shortcode,
      emojiData: { name: emoji.name, url: emoji.url },
    };
  }

  return {
    content: customEmojiContent || emoji.name || '❤',
    emojiData: null,
  };
}

/**
 * Resolve an emoji for outbound federation by querying the DB.
 *
 * @param emojiId            - UUID from the emojis table (nullable)
 * @param customEmojiContent - The `custom_emoji_content` field from the
 *                             reaction / interaction row (unicode char for
 *                             standard emojis, null for custom emojis)
 */
export async function resolveOutboundEmoji(
  emojiId: string | null | undefined,
  customEmojiContent: string | null | undefined,
): Promise<ResolvedEmoji> {
  if (!emojiId) {
    return { content: customEmojiContent || '❤', emojiData: null };
  }

  const supabase = getSupabaseClient();
  const { data: emoji } = await supabase
    .from('emojis')
    .select('name, url, domain')
    .eq('id', emojiId)
    .single();

  if (!emoji) {
    logger.warn(`Emoji ${emojiId} not found in emojis table`);
    return { content: customEmojiContent || '❤', emojiData: null };
  }

  return formatEmojiForFederation(emoji, customEmojiContent);
}
