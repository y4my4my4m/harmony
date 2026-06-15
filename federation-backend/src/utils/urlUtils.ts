/**
 * URL utilities for handling local and remote media URLs
 */

import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';

interface StorageTransform {
  width?: number;
  height?: number;
  resize?: 'contain' | 'cover' | 'fill';
  quality?: number;
}

/**
 * Replace internal Supabase URL with public URL
 */
function makeUrlPublic(url: string): string {
  const internalUrl = config.SUPABASE_URL;
  const publicUrl = config.PUBLIC_SUPABASE_URL;
  
  if (internalUrl === publicUrl) {
    return url;
  }
  
  return url.replace(internalUrl, publicUrl!);
}

/**
 * Convert a storage path to a full absolute URL for federation.
 * Handles relative storage paths, absolute URLs, and root-relative paths.
 */
function getFullStorageUrl(
  path: string | null | undefined,
  bucket: string,
  transform?: StorageTransform
): string | null {
  if (!path || typeof path !== 'string') {
    return null;
  }

  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }

  if (path.includes('/') && !path.startsWith('/')) {
    const supabase = getSupabaseClient();
    const options = transform ? { transform } : undefined;
    const { data } = supabase.storage.from(bucket).getPublicUrl(path, options);
    return makeUrlPublic(data.publicUrl);
  }

  if (path.startsWith('/')) {
    return `https://${config.INSTANCE_DOMAIN}${path}`;
  }

  return null;
}

export function getFullAvatarUrl(avatarUrl: string | null | undefined): string | null {
  return getFullStorageUrl(avatarUrl, 'avatars', {
    width: 256, height: 256, resize: 'contain', quality: 80,
  });
}

export function getFullEmojiUrl(emojiUrl: string | null | undefined): string | null {
  return getFullStorageUrl(emojiUrl, 'emojis');
}

export function getFullBannerUrl(bannerUrl: string | null | undefined): string | null {
  return getFullStorageUrl(bannerUrl, 'banners', {
    width: 1500, height: 500, resize: 'cover', quality: 80,
  });
}

const DEFAULT_SERVER_ICON = '/default_server.webp';

/**
 * Whether a server icon value is the built-in default (not a custom upload).
 * Matches the DB default and any federation-mangled storage URLs for it.
 */
export function isDefaultServerIcon(icon: string | null | undefined): boolean {
  if (!icon || typeof icon !== 'string') return true;
  const trimmed = icon.trim();
  if (!trimmed) return true;
  if (trimmed === DEFAULT_SERVER_ICON) return true;
  if (trimmed.includes('default_server')) return true;
  return false;
}

export function getFullServerIconUrl(icon: string | null | undefined): string | null {
  if (isDefaultServerIcon(icon)) return null;
  return getFullStorageUrl(icon, 'server_icons', {
    width: 96, height: 96, resize: 'contain', quality: 80,
  });
}

export function getFullServerBannerUrl(banner: string | null | undefined): string | null {
  if (!banner || typeof banner !== 'string' || !banner.trim()) return null;
  return getFullStorageUrl(banner, 'server_banners', {
    width: 1280, height: 400, resize: 'cover', quality: 80,
  });
}
