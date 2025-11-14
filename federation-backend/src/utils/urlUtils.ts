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
 * Convert avatar_url to full absolute URL for federation
 * Handles:
 * - Relative paths (local users): "user-id/avatar.webp" -> full Supabase URL
 * - Absolute URLs (remote users): "https://..." -> return as-is
 * - Null/undefined: return null
 */
export function getFullAvatarUrl(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl || typeof avatarUrl !== 'string') {
    return null;
  }

  // If it's already a full URL (remote user), return as-is
  if (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) {
    return avatarUrl;
  }

  // If it's a relative path (local user), convert to full Supabase URL
  if (avatarUrl.includes('/') && !avatarUrl.startsWith('/')) {
    const supabase = getSupabaseClient();
    const { data } = supabase.storage
      .from('avatars')
      .getPublicUrl(avatarUrl);
    
    // Replace localhost with public URL if needed
    return makeUrlPublic(data.publicUrl);
  }

  // If it's a local asset path (starts with /), make it absolute
  if (avatarUrl.startsWith('/')) {
    return `https://${config.INSTANCE_DOMAIN}${avatarUrl}`;
  }

  // Fallback: shouldn't reach here, but return null if unexpected format
  return null;
}

/**
 * Convert banner_url to full absolute URL for federation
 * Same logic as avatar, but for banners bucket
 */
export function getFullBannerUrl(bannerUrl: string | null | undefined): string | null {
  if (!bannerUrl || typeof bannerUrl !== 'string') {
    return null;
  }

  // If it's already a full URL (remote user), return as-is
  if (bannerUrl.startsWith('http://') || bannerUrl.startsWith('https://')) {
    return bannerUrl;
  }

  // If it's a relative path (local user), convert to full Supabase URL
  if (bannerUrl.includes('/') && !bannerUrl.startsWith('/')) {
    const supabase = getSupabaseClient();
    const { data } = supabase.storage
      .from('banners')
      .getPublicUrl(bannerUrl);
    
    // Replace localhost with public URL if needed
    return makeUrlPublic(data.publicUrl);
  }

  // If it's a local asset path (starts with /), make it absolute
  if (bannerUrl.startsWith('/')) {
    return `https://${config.INSTANCE_DOMAIN}${bannerUrl}`;
  }

  // Fallback
  return null;
}

