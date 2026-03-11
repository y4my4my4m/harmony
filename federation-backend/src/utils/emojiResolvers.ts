/**
 * Shared emoji resolution utilities for federation reaction handlers.
 *
 * Both post reactions (DatabaseListener, reactionHandler) and channel reactions
 * (ChannelReactionHandler) need to resolve an emoji_id + custom_emoji_content
 * into an ActivityPub-compatible representation. This module centralises that
 * logic so every outbound reaction is formatted identically.
 */

import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';
import { getFullEmojiUrl } from './urlUtils.js';
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
 *
 * @param targetDomain - When set, if the emoji originates from this domain
 *                       we use `:name:` instead of `:name@domain:` so the
 *                       remote instance recognises it as its own local emoji.
 */
export function formatEmojiForFederation(
  emoji: { name: string; url: string | null; domain?: string | null } | null,
  customEmojiContent: string | null | undefined,
  targetDomain?: string,
): ResolvedEmoji {
  if (!emoji) {
    return { content: customEmojiContent || '❤', emojiData: null };
  }

  if (emoji.url) {
    const fullUrl = getFullEmojiUrl(emoji.url) || emoji.url;
    // When the emoji originates from the target instance, use `:name:` (local)
    // so the remote instance recognises it as its own emoji.
    // Otherwise always qualify with the originating domain — our own local
    // emojis are never "local" to a remote instance.
    const useLocalShortcode = emoji.domain
      ? (targetDomain && emoji.domain.toLowerCase() === targetDomain.toLowerCase())
      : false;
    const shortcode = useLocalShortcode
      ? `:${emoji.name}:`
      : `:${emoji.name}@${emoji.domain || config.INSTANCE_DOMAIN}:`;
    return {
      content: shortcode,
      emojiData: { name: emoji.name, url: fullUrl },
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
 * @param targetDomain       - Domain of the remote instance receiving the
 *                             activity. When the emoji originates from this
 *                             domain we omit the @domain suffix so the remote
 *                             instance maps it to its own local emoji.
 */
export async function resolveOutboundEmoji(
  emojiId: string | null | undefined,
  customEmojiContent: string | null | undefined,
  targetDomain?: string,
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

  return formatEmojiForFederation(emoji, customEmojiContent, targetDomain);
}
