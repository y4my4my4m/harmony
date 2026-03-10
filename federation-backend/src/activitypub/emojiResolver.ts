/**
 * Resolve emoji shortcodes in a local user's display_name and bio
 * so that profileToActor() can include proper AP Emoji tags.
 *
 * For custom emojis (with image URLs): keeps shortcode in name, adds tag entries
 * For standard unicode emojis: shortcodes without DB matches are left as-is
 * (the display will degrade gracefully on remote instances)
 */

import { logger } from '../utils/logger.js';

export async function resolveLocalProfileEmojis(profile: any, supabase: any): Promise<void> {
  const fieldsToScan = [profile.display_name, profile.bio].filter(Boolean).join(' ');
  const shortcodeRegex = /:([a-zA-Z0-9_+-]+):/g;
  const matches = [...fieldsToScan.matchAll(shortcodeRegex)];

  if (matches.length === 0) return;

  const shortcodes = [...new Set(matches.map(m => m[1]))];

  // Look up custom emojis from our database (only those with image URLs)
  const { data: dbEmojis } = await supabase
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

  // Also check remote_emojis_cache for emojis from other instances
  const uncachedCodes = shortcodes.filter(s => !customEmojiMap.has(s));
  if (uncachedCodes.length > 0) {
    const { data: remoteCached } = await supabase
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
    const dnMatches = [...profile.display_name.matchAll(shortcodeRegex)];
    for (const m of dnMatches) {
      const code = m[1];
      const emoji = customEmojiMap.get(code);
      if (emoji) {
        displayNameEmojis.push({ name: code, url: emoji.url, id: emoji.id });
      }
    }
  }

  if (profile.bio) {
    const bioMatches = [...profile.bio.matchAll(shortcodeRegex)];
    for (const m of bioMatches) {
      const code = m[1];
      const emoji = customEmojiMap.get(code);
      if (emoji) {
        bioEmojis.push({ name: code, url: emoji.url, id: emoji.id });
      }
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
