/**
 * URL utilities for handling local and remote media URLs
 */

import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';

/**
 * Replace internal Supabase URL with public URL
 * Handles cases where SUPABASE_URL is localhost but PUBLIC_SUPABASE_URL is the public domain
 */
function makeUrlPublic(url: string): string {
  const internalUrl = config.SUPABASE_URL;
  const publicUrl = config.PUBLIC_SUPABASE_URL;
  
  // If they're the same, no replacement needed
  if (internalUrl === publicUrl) {
    return url;
  }
  
  // Replace internal URL with public URL
  return url.replace(internalUrl, publicUrl!);
}

/**
 * Convert avatar_url to full absolute URL for federation.
 * Uses Supabase's image render endpoint (imgproxy) so remote instances
 * receive a reasonably-sized image instead of the raw original.
 *
 * Handles:
 * - Relative paths (local users): "user-id/avatar.webp" -> rendered Supabase URL
 * - Absolute URLs (remote users): "https://..." -> return as-is
 * - Null/undefined: return null
 */
export function getFullAvatarUrl(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl || typeof avatarUrl !== 'string') {
    return null;
  }

  if (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) {
    return avatarUrl;
  }

  if (avatarUrl.includes('/') && !avatarUrl.startsWith('/')) {
    const supabase = getSupabaseClient();
    const { data } = supabase.storage
      .from('avatars')
      .getPublicUrl(avatarUrl, {
        transform: { width: 256, height: 256, resize: 'contain', quality: 80 },
      });

    return makeUrlPublic(data.publicUrl);
  }

  if (avatarUrl.startsWith('/')) {
    return `https://${config.INSTANCE_DOMAIN}${avatarUrl}`;
  }

  return null;
}

/**
 * Convert an emoji URL to a full absolute URL for federation.
 * Handles relative storage paths (local emojis) and full URLs (remote emojis).
 */
export function getFullEmojiUrl(emojiUrl: string | null | undefined): string | null {
  if (!emojiUrl || typeof emojiUrl !== 'string') {
    return null;
  }

  if (emojiUrl.startsWith('http://') || emojiUrl.startsWith('https://')) {
    return emojiUrl;
  }

  if (emojiUrl.includes('/') && !emojiUrl.startsWith('/')) {
    const supabase = getSupabaseClient();
    const { data } = supabase.storage
      .from('emojis')
      .getPublicUrl(emojiUrl);
    return makeUrlPublic(data.publicUrl);
  }

  if (emojiUrl.startsWith('/')) {
    return `https://${config.INSTANCE_DOMAIN}${emojiUrl}`;
  }

  return null;
}

/**
 * Convert banner_url to full absolute URL for federation.
 * Uses Supabase's image render endpoint so remote instances receive
 * a reasonably-sized banner.
 */
export function getFullBannerUrl(bannerUrl: string | null | undefined): string | null {
  if (!bannerUrl || typeof bannerUrl !== 'string') {
    return null;
  }

  if (bannerUrl.startsWith('http://') || bannerUrl.startsWith('https://')) {
    return bannerUrl;
  }

  if (bannerUrl.includes('/') && !bannerUrl.startsWith('/')) {
    const supabase = getSupabaseClient();
    const { data } = supabase.storage
      .from('banners')
      .getPublicUrl(bannerUrl, {
        transform: { width: 1500, height: 500, resize: 'cover', quality: 80 },
      });

    return makeUrlPublic(data.publicUrl);
  }

  if (bannerUrl.startsWith('/')) {
    return `https://${config.INSTANCE_DOMAIN}${bannerUrl}`;
  }

  return null;
}

