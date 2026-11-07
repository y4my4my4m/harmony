/**
 * Size of the photos a local post federates (instance_config federate_image_max_px).
 *
 * A JPEG, PNG or still WebP in this instance's user_media bucket whose longest side exceeds
 * the cap is sent as its storage render, fitted inside cap × cap; the stored object, and what
 * Harmony shows, stay the original. GIF, APNG, animated WebP, SVG, video, remote URLs, images
 * of unknown size and sources over MAX_SOURCE_PIXELS are sent as stored. A cap of 0 sends
 * every original.
 *
 * A post with media carries the cap in force when its media was first attached
 * (posts.metadata.federate_image_max_px, stamp_post_federate_image_cap in
 * 20261107700001_federate_image_cap.sql), so a later Update or refetch names the same URL
 * after the setting changes. Rows without it use the current setting.
 *
 * format=origin: storage-api forwards no Accept to imgproxy, and the render keeps the source
 * format whatever Accept the fetch or a proxy in front of storage sends (ImageRenderer,
 * storage-api v1.25.7 through v1.89.12). The attachment's mediaType stays the stored one.
 * Without it, a PNG fetched with Accept image/webp comes back WebP.
 */
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from './logger.js';

export const FEDERATE_IMAGE_MAX_PX_KEY = 'federate_image_max_px';
export const DEFAULT_FEDERATE_IMAGE_MAX_PX = 1920;
/** storage-api clamps render width and height to IMAGE_TRANSFORMATION_LIMIT_MAX_SIZE, default 2000. */
export const RENDER_MAX_SIDE = 2000;
/** IMGPROXY_MAX_SRC_RESOLUTION of self-host/supabase-overrides.yml, 50 megapixels. */
export const MAX_SOURCE_PIXELS = 50_000_000;
export const RENDER_QUALITY = 85;

const RENDERED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const OBJECT_SEGMENT = '/storage/v1/object/public/user_media/';
const RENDER_SEGMENT = '/storage/v1/render/image/public/user_media/';

/** A stored cap: 0 to 1,000,000, rounded, else the default; stamp_post_federate_image_cap reads it alike. */
export function parseImageMaxPx(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return n >= 0 && n <= 1_000_000 ? Math.round(n) : DEFAULT_FEDERATE_IMAGE_MAX_PX;
}

const CONFIG_TTL_MS = 60_000;
let cached: { at: number; value: number } | null = null;

export async function getFederateImageMaxPx(now = Date.now()): Promise<number> {
  if (cached && now - cached.at < CONFIG_TTL_MS) return cached.value;
  let raw: unknown;
  try {
    const { data, error } = await getSupabaseClient()
      .from('instance_config')
      .select('config_value')
      .eq('config_key', FEDERATE_IMAGE_MAX_PX_KEY)
      .maybeSingle();
    if (error) throw error;
    raw = data?.config_value;
  } catch (error) {
    // Unread, the default applies and is not cached.
    logger.warn('federate_image_max_px unavailable, using the default:', (error as Error)?.message);
    return DEFAULT_FEDERATE_IMAGE_MAX_PX;
  }
  const value = parseImageMaxPx(raw);
  cached = { at: now, value };
  return value;
}

export function resetFederateImageMaxPxCache(): void {
  cached = null;
}

/** The cap a post's photos federate under: its stamped one, else the current setting. */
export async function postImageMaxPx(post: any): Promise<number> {
  const stamped = post?.metadata?.[FEDERATE_IMAGE_MAX_PX_KEY];
  if (typeof stamped === 'number' && Number.isFinite(stamped) && stamped >= 0) return Math.round(stamped);
  return getFederateImageMaxPx();
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
}

/** Bases this instance's storage is reached at: PUBLIC_SUPABASE_URL and https://INSTANCE_DOMAIN. */
function storageBases(): URL[] {
  const out: URL[] = [];
  for (const raw of [config.PUBLIC_SUPABASE_URL, `https://${config.INSTANCE_DOMAIN}`]) {
    try {
      if (raw) out.push(new URL(raw));
    } catch {
      // Not a URL.
    }
  }
  return out;
}

/** The object path after /user_media/ of a local public user_media URL, else null. */
function localUserMediaPath(url: string): { base: string; path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  for (const base of storageBases()) {
    if (parsed.origin !== base.origin) continue;
    const prefix = `${base.pathname.replace(/\/+$/, '')}${OBJECT_SEGMENT}`;
    if (parsed.pathname.startsWith(prefix) && parsed.pathname.length > prefix.length) {
      return { base: `${parsed.origin}${base.pathname.replace(/\/+$/, '')}`, path: parsed.pathname.slice(prefix.length) };
    }
  }
  return null;
}

export interface FederatedImageInput {
  url: string;
  mediaType: string;
  width?: unknown;
  height?: unknown;
  animated?: unknown;
}

export interface FederatedImage {
  url: string;
  width: number | null;
  height: number | null;
}

/**
 * The URL and size an image attachment federates with under `maxPx`. Width and height are
 * the stored ones when the original is sent, the fitted ones when the render is: longest
 * side = cap, the other rounded to nearest, as imgproxy v4.0.21 resizing_type:fit returns
 * (3001×2001 → 1920×1280, 1999×3333 → 1152×1920, 3001×2001 at 1000 → 1000×667; measured
 * 2026-11-07).
 */
export function federatedImage(input: FederatedImageInput, maxPx: number): FederatedImage {
  const width = positiveInt(input.width);
  const height = positiveInt(input.height);
  const original = { url: input.url, width, height };
  const cap = Math.min(Math.max(0, Math.round(maxPx || 0)), RENDER_MAX_SIDE);
  if (cap <= 0 || !width || !height) return original;
  if (input.animated === true) return original;
  const mediaType = input.mediaType.toLowerCase().split(';')[0].trim();
  if (!RENDERED_TYPES.has(mediaType)) return original;
  const longest = Math.max(width, height);
  if (longest <= cap || width * height > MAX_SOURCE_PIXELS) return original;
  const local = localUserMediaPath(input.url);
  if (!local || /\.apng$/i.test(local.path)) return original;

  const scale = cap / longest;
  const fitted = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
  const query = `width=${cap}&height=${cap}&resize=contain&quality=${RENDER_QUALITY}&format=origin`;
  return { url: `${local.base}${RENDER_SEGMENT}${local.path}?${query}`, ...fitted };
}
