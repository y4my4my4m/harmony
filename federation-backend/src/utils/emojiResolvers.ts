/**
 * Unified emoji resolution utilities for federation.
 *
 * Handles:
 * - Outbound reaction emojis (post reactions, channel reactions)
 * - Profile emoji shortcodes (display_name, bio)
 */

import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';
import { getFullEmojiUrl } from './urlUtils.js';
import { logger } from './logger.js';

export interface ResolvedEmoji {
  /** The string to put in `content` / `_misskey_reaction` - either a unicode
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
    // Otherwise always qualify with the originating domain - our own local
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

/**
 * Resolve emoji shortcodes in a local user's display_name and bio
 * so that profileToActor() can include proper AP Emoji tags.
 */
export async function resolveLocalProfileEmojis(profile: any, supabase?: any): Promise<void> {
  const db = supabase || getSupabaseClient();
  const fieldsToScan = [profile.display_name, profile.bio].filter(Boolean).join(' ');
  const shortcodeRegex = /:([a-zA-Z0-9_+-]+):/g;
  const matches = [...fieldsToScan.matchAll(shortcodeRegex)];

  if (matches.length === 0) return;

  const shortcodes = [...new Set(matches.map(m => m[1]))];

  const { data: dbEmojis } = await db
    .from('emojis')
    .select('id, name, url')
    .in('name', shortcodes)
    .not('url', 'is', null);

  const customEmojiMap = new Map<string, { id: string; name: string; url: string }>();
  if (dbEmojis) {
    for (const e of dbEmojis) {
      customEmojiMap.set(e.name, e);
    }
  }

  const uncachedCodes = shortcodes.filter(s => !customEmojiMap.has(s));
  if (uncachedCodes.length > 0) {
    const { data: remoteCached } = await db
      .from('remote_emojis_cache')
      .select('shortcode, url')
      .in('shortcode', uncachedCodes);

    if (remoteCached) {
      for (const e of remoteCached) {
        if (e.url && !customEmojiMap.has(e.shortcode)) {
          customEmojiMap.set(e.shortcode, {
            id: `remote-${e.shortcode}`,
            name: e.shortcode,
            url: e.url,
          });
        }
      }
    }
  }

  const displayNameEmojis: Array<{ name: string; url: string; id?: string }> = [];
  const bioEmojis: Array<{ name: string; url: string; id?: string }> = [];

  if (profile.display_name) {
    for (const m of [...profile.display_name.matchAll(shortcodeRegex)]) {
      const emoji = customEmojiMap.get(m[1]);
      if (emoji) displayNameEmojis.push({ name: m[1], url: emoji.url, id: emoji.id });
    }
  }

  if (profile.bio) {
    for (const m of [...profile.bio.matchAll(shortcodeRegex)]) {
      const emoji = customEmojiMap.get(m[1]);
      if (emoji) bioEmojis.push({ name: m[1], url: emoji.url, id: emoji.id });
    }
  }

  if (displayNameEmojis.length > 0 || bioEmojis.length > 0) {
    const existingMeta = profile.federation_metadata
      ? (typeof profile.federation_metadata === 'string'
        ? JSON.parse(profile.federation_metadata)
        : profile.federation_metadata)
      : {};

    existingMeta.display_name_emojis = displayNameEmojis;
    existingMeta.bio_emojis = bioEmojis;
    profile.federation_metadata = existingMeta;

    logger.debug(`Resolved ${displayNameEmojis.length} display name + ${bioEmojis.length} bio emojis for ${profile.username}`);
  }
}
