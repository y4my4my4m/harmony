/**
 * Helpers for the server-rendered pages served to browsers and link-preview crawlers.
 */

import config from '../config/index.js';

export function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Resolve a Supabase storage URL to a full absolute URL using the render
 * (imgproxy) path for on-the-fly resizing. Falls through for already-absolute
 * URLs (e.g. federated avatars/emojis from other instances).
 */
export function resolveStorageUrl(
  raw: string | null | undefined,
  bucket: string,
  width?: number,
  height?: number,
): string {
  if (!raw || typeof raw !== 'string') return '';

  // Already a full URL - append transform query params if it's our Supabase
  // storage URL and no transforms are present yet
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    if (width && raw.includes('/storage/v1/') && !raw.includes('width=')) {
      const sep = raw.includes('?') ? '&' : '?';
      return `${raw}${sep}width=${width}&height=${height || width}&resize=contain&quality=80`;
    }
    return raw;
  }
  if (raw.startsWith('/')) return raw;

  const base = config.PUBLIC_SUPABASE_URL || config.SUPABASE_URL || '';
  if (!base) return raw;

  if (width) {
    return `${base}/storage/v1/render/image/public/${bucket}/${raw}?width=${width}&height=${height || width}&resize=contain&quality=80`;
  }
  return `${base}/storage/v1/object/public/${bucket}/${raw}`;
}

/**
 * Original object of a storage image, for link-preview crawlers: a render can answer WebP,
 * which some crawlers do not display.
 */
export function originalStorageUrl(raw: string | null | undefined, bucket: string): string {
  const url = resolveStorageUrl(raw, bucket);
  if (!url.includes('/storage/v1/render/image/public/')) return url;
  return url.replace('/storage/v1/render/image/public/', '/storage/v1/object/public/').split('?')[0];
}
