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
