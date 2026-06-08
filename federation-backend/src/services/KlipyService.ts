/**
 * KlipyService - server-side GIF provider (Klipy native v1 API)
 *
 * Replaces the old client-side Tenor integration. Lives on the backend for two
 * reasons:
 *   1. The Klipy app key sits in the request PATH, so calling Klipy from the
 *      browser would expose it. Here it stays in env and never reaches clients.
 *   2. Ads are a property of the key (toggled in the Klipy dashboard). We hold
 *      both an ad-enabled and an ad-free key and pick per request based on the
 *      viewer's supporter tier. The no-ads key is therefore never shippable to
 *      the frontend, and the ads decision can't be bypassed client-side.
 *
 * The native v1 API is used (not the Tenor-compat /v2 surface) because only the
 * native API interleaves `type: "ad"` objects, which the whole monetization
 * model depends on. Responses are normalized into a small discriminated shape so
 * the frontend keeps its existing `Gif` model and just learns about ad items.
 */

import config from '../config/index.js';
import { logger } from '../utils/logger.js';

export type GifKind = 'trending' | 'search';

export interface NormalizedGif {
  kind: 'gif';
  id: string;
  slug?: string;
  title?: string;
  /** Klipy item page (klipy.com/gifs/...) for attribution links. */
  itemUrl?: string;
  /** True for clip media (mp4/webm) — rendered/sent as video, not an image. */
  isVideo?: boolean;
  media_formats: {
    gif: { url: string };
    gifpreview: { url: string };
    mp4: { url: string };
    webm: { url: string };
  };
}

export interface NormalizedAd {
  kind: 'ad';
  id: string;
  content: string;
  width: number;
  height: number;
}

export type GifFeedItem = NormalizedGif | NormalizedAd;

export interface GifFeed {
  items: GifFeedItem[];
  page: number;
  hasNext: boolean;
}

/** Klipy native media collections we proxy. */
export type GifMediaType = 'gifs' | 'stickers' | 'clips' | 'memes' | 'ai-emojis';

/**
 * Maps our media type to Klipy's API path slug. These differ from both our
 * names and the public web paths: memes → static-memes, ai-emojis → emojis
 * (the browse/trending endpoint lives at /emojis; only generation uses
 * /ai-emojis).
 */
const MEDIA_PATH_SLUG: Record<GifMediaType, string> = {
  'gifs': 'gifs',
  'stickers': 'stickers',
  'clips': 'clips',
  'memes': 'static-memes',
  'ai-emojis': 'emojis',
};

const VIDEO_MEDIA: ReadonlySet<GifMediaType> = new Set<GifMediaType>(['clips']);

/**
 * Public klipy.com page path per media type (for the attribution watermark link).
 * Note these differ from the API slugs: memes → static-memes, ai-emojis → ai-gifs.
 * Source: Klipy's Embedly URL scheme (clips|gifs|stickers|ai-gifs|static-memes).
 */
const MEDIA_WEB_PATH: Record<GifMediaType, string> = {
  'gifs': 'gifs',
  'stickers': 'stickers',
  'clips': 'clips',
  'memes': 'static-memes',
  'ai-emojis': 'ai-gifs',
};

export function isValidMediaType(value: string): value is GifMediaType {
  return Object.prototype.hasOwnProperty.call(MEDIA_PATH_SLUG, value);
}

/** Klipy ad query params (hyphenated keys). Sanitized before forwarding upstream. */
export type KlipyAdParams = Record<string, string>;

/** Params the federation proxy accepts from clients and forwards to Klipy. */
export const KLIPY_AD_QUERY_KEYS: ReadonlySet<string> = new Set([
  'ad-min-width',
  'ad-max-width',
  'ad-min-height',
  'ad-max-height',
  'ad-app-version',
  'ad-os',
  'ad-osv',
  'ad-hwv',
  'ad-make',
  'ad-model',
  'ad-device-w',
  'ad-device-h',
  'ad-ppi',
  'ad-pxratio',
  'ad-language',
  'ad-connection-type',
  'ad-position',
]);

export interface FetchGifsOptions {
  kind: GifKind;
  /** Which Klipy collection to query. Defaults to 'gifs'. */
  mediaType?: GifMediaType;
  query?: string;
  page?: number;
  perPage?: number;
  locale?: string;
  contentFilter?: 'off' | 'low' | 'medium' | 'high';
  /** Stable per-user id (profile id). Required by Klipy for ads + personalization. */
  customerId: string;
  /** When true, request the ad-enabled key and pass ad slot dimensions. */
  withAds: boolean;
  /** Forwarded to Klipy; ad fill is influenced by the end-user User-Agent. */
  userAgent?: string;
  /** Device/slot targeting params from the client (already sanitized). */
  adParams?: KlipyAdParams;
}

// Size preference order when flattening Klipy's per-size `file` object.
const DISPLAY_SIZES = ['md', 'hd', 'sm', 'xs'] as const;
const PREVIEW_SIZES = ['sm', 'xs', 'md', 'hd'] as const;

type KlipyFile = Record<string, Record<string, { url?: string } | undefined> | undefined>;

function pickUrl(file: KlipyFile | undefined, sizes: readonly string[], format: string): string | undefined {
  if (!file) return undefined;
  // Flat structure (clips): file[format] is a direct URL string, not sized.
  const flat = (file as Record<string, unknown>)[format];
  if (typeof flat === 'string') return flat;
  for (const size of sizes) {
    const url = file[size]?.[format]?.url;
    if (url) return url;
  }
  return undefined;
}

/** True when at least one Klipy key is configured (GIF search is available). */
export function isKlipyConfigured(): boolean {
  return Boolean(config.KLIPY_API_KEY_ADS || config.KLIPY_API_KEY_NOADS);
}

/** True when an ad-enabled key exists (otherwise ads can never be served). */
export function hasAdsKey(): boolean {
  return Boolean(config.KLIPY_API_KEY_ADS);
}

/**
 * Resolve which key to use. Supporters (withAds=false) get the no-ads key when
 * it exists; everyone else gets the ads key. If only one key is configured it is
 * used for both, and ad objects are stripped downstream when the viewer is
 * ad-free.
 */
function resolveKey(withAds: boolean): string | undefined {
  const adsKey = config.KLIPY_API_KEY_ADS;
  const noAdsKey = config.KLIPY_API_KEY_NOADS;
  if (withAds) return adsKey || noAdsKey;
  return noAdsKey || adsKey;
}

function normalizeGif(raw: any, mediaType: GifMediaType = 'gifs'): NormalizedGif | null {
  const file = raw?.file as KlipyFile | undefined;
  const isVideo = VIDEO_MEDIA.has(mediaType);

  const mp4Url = pickUrl(file, DISPLAY_SIZES, 'mp4');
  const webmUrl = pickUrl(file, DISPLAY_SIZES, 'webm');
  const animatedGif = pickUrl(file, DISPLAY_SIZES, 'gif');
  const staticImg =
    pickUrl(file, DISPLAY_SIZES, 'webp') || pickUrl(file, DISPLAY_SIZES, 'png');

  // The "primary" URL is what gets sent in a message: a video src for clips,
  // otherwise the best available still/animated image.
  const primaryUrl = isVideo
    ? mp4Url || webmUrl || animatedGif
    : animatedGif || staticImg || raw?.url;
  if (!primaryUrl) return null;

  // Previews: transparent media (stickers/ai-emojis) avoid jpg to keep alpha;
  // clips fall back to a poster still.
  const transparent = mediaType === 'stickers' || mediaType === 'ai-emojis';
  const previewUrl =
    (transparent
      ? pickUrl(file, PREVIEW_SIZES, 'webp') ||
        pickUrl(file, PREVIEW_SIZES, 'png') ||
        pickUrl(file, PREVIEW_SIZES, 'gif')
      : pickUrl(file, PREVIEW_SIZES, 'jpg') ||
        pickUrl(file, PREVIEW_SIZES, 'webp') ||
        pickUrl(file, PREVIEW_SIZES, 'png') ||
        pickUrl(file, PREVIEW_SIZES, 'gif')) || primaryUrl;

  // Prefer a klipy.com page URL when the API provides one (clips include it as
  // raw.url); otherwise build it from the slug. Ignore static.* (media) URLs.
  const slug = typeof raw?.slug === 'string' ? raw.slug : undefined;
  const rawPageUrl =
    typeof raw?.url === 'string' && /(^|\.)klipy\.com\//.test(raw.url) && !raw.url.includes('static')
      ? raw.url
      : undefined;
  const itemUrl =
    rawPageUrl ||
    (typeof raw?.itemurl === 'string'
      ? raw.itemurl
      : typeof raw?.item_url === 'string'
        ? raw.item_url
        : slug
          ? `https://klipy.com/${MEDIA_WEB_PATH[mediaType]}/${slug}`
          : undefined);

  return {
    kind: 'gif',
    id: String(raw?.id ?? raw?.slug ?? primaryUrl),
    slug: raw?.slug,
    title: raw?.title || undefined,
    itemUrl,
    isVideo: isVideo || undefined,
    media_formats: {
      gif: { url: primaryUrl },
      gifpreview: { url: previewUrl },
      mp4: { url: mp4Url || primaryUrl },
      webm: { url: webmUrl || mp4Url || primaryUrl },
    },
  };
}

function normalizeAd(raw: any, index: number): NormalizedAd | null {
  const content =
    typeof raw?.content === 'string'
      ? raw.content
      : typeof raw?.ad_content === 'string'
        ? raw.ad_content
        : undefined;
  if (!content) return null;
  return {
    kind: 'ad',
    id: `ad:${index}`,
    content,
    width: Number(raw?.width) || 0,
    height: Number(raw?.height) || 0,
  };
}

export class KlipyService {
  /**
   * Fetch a page of GIFs (trending or search) and normalize the result. When
   * `withAds` is false, any ad objects Klipy returns are dropped as a safety net
   * (the no-ads key normally returns none, but a single-key deployment might).
   */
  static async fetchGifs(opts: FetchGifsOptions): Promise<GifFeed> {
    const key = resolveKey(opts.withAds);
    if (!key) {
      throw new Error('Klipy is not configured');
    }

    const page = Math.max(1, opts.page || 1);
    const perPage = Math.min(50, Math.max(1, opts.perPage || 24));

    const mediaType: GifMediaType = opts.mediaType || 'gifs';
    const slug = MEDIA_PATH_SLUG[mediaType];
    const path = `${slug}/${opts.kind === 'search' ? 'search' : 'trending'}`;
    const url = new URL(`${config.KLIPY_BASE_URL}/api/v1/${key}/${path}`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('customer_id', opts.customerId);
    if (opts.kind === 'search' && opts.query) url.searchParams.set('q', opts.query);
    if (opts.locale) url.searchParams.set('locale', opts.locale);
    url.searchParams.set('content_filter', opts.contentFilter || 'medium');

    // Ad slot sizing + device targeting. Only meaningful when the ads key is in
    // use. Bounds follow Klipy's recommended 50..(device width) x 50..250.
    if (opts.withAds) {
      const ad = opts.adParams ?? {};
      url.searchParams.set('ad-min-width', ad['ad-min-width'] ?? '50');
      url.searchParams.set('ad-max-width', ad['ad-max-width'] ?? '384');
      url.searchParams.set('ad-min-height', ad['ad-min-height'] ?? '50');
      url.searchParams.set('ad-max-height', ad['ad-max-height'] ?? '250');
      for (const [key, value] of Object.entries(ad)) {
        if (!KLIPY_AD_QUERY_KEYS.has(key)) continue;
        if (key.startsWith('ad-min-') || key.startsWith('ad-max-')) continue;
        url.searchParams.set(key, value);
      }
    }

    let payload: any;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          // Klipy ad fill is influenced by the end-user UA; forward when present.
          'User-Agent': opts.userAgent || 'HarmonyFederation/1.0',
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger.warn(`Klipy ${path} returned ${res.status}: ${body.slice(0, 200)}`);
        throw new Error(`Klipy request failed (${res.status})`);
      }
      payload = await res.json();
    } catch (err) {
      logger.error('Klipy request error:', err);
      throw err instanceof Error ? err : new Error('Klipy request error');
    }

    const data = payload?.data ?? {};
    const rawItems: any[] = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(payload?.data)
        ? payload.data
        : [];

    const items: GifFeedItem[] = [];
    let rawAdCount = 0;
    rawItems.forEach((raw, index) => {
      const itemType = String(raw?.type ?? '').toLowerCase();
      if (itemType === 'ad') {
        rawAdCount++;
        if (!opts.withAds) return; // safety net: never surface ads to ad-free users
        const ad = normalizeAd(raw, index);
        if (ad) items.push(ad);
        return;
      }
      const gif = normalizeGif(raw, mediaType);
      if (gif) items.push(gif);
    });

    if (opts.withAds && rawAdCount === 0 && rawItems.length > 0) {
      logger.debug(
        `Klipy ${path}: ads requested but response had 0 ad objects (${rawItems.length} items). ` +
          'Confirm ads are enabled for KLIPY_API_KEY_ADS in the Klipy Partner Dashboard.',
      );
    }

    return {
      items,
      page: Number(data?.current_page) || page,
      hasNext: Boolean(data?.has_next),
    };
  }

  /**
   * Fetch search suggestions (no query) or autocomplete (with query) terms.
   * Klipy exposes these as `/search-suggestions` and `/autocomplete` under the
   * keyed base path. Failures degrade to an empty list — suggestions are a
   * nice-to-have, never a hard dependency.
   */
  static async fetchSuggestions(opts: {
    query?: string;
    locale?: string;
    userAgent?: string;
  }): Promise<string[]> {
    // Suggestions don't need ad selection; use whichever key exists.
    const key = config.KLIPY_API_KEY_NOADS || config.KLIPY_API_KEY_ADS;
    if (!key) return [];

    const q = opts.query?.trim();
    const endpoint = q ? 'autocomplete' : 'search-suggestions';
    const url = new URL(`${config.KLIPY_BASE_URL}/api/v1/${key}/${endpoint}`);
    if (q) url.searchParams.set('q', q);
    if (opts.locale) url.searchParams.set('locale', opts.locale);

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': opts.userAgent || 'HarmonyFederation/1.0',
        },
      });
      if (!res.ok) return [];
      const payload: any = await res.json();
      return extractSuggestionStrings(payload);
    } catch (err) {
      logger.debug('Klipy suggestions request failed (non-fatal):', err);
      return [];
    }
  }
}

export interface GeneratedEmoji {
  /** Raw image bytes returned by Klipy (base64 generation result). */
  buffer: Buffer;
  mimeType: string;
}

/** Status of an async AI emoji generation poll. */
export type GenerationStatus =
  | { state: 'processing' }
  | { state: 'failed' }
  | { state: 'success'; image: GeneratedEmoji };

/**
 * Kick off an AI emoji generation. Klipy returns a job id immediately and
 * processes asynchronously. When `callbackUrl` is provided, Klipy POSTs the
 * finished emoji there (preferred — no long-held request). The id is also used
 * for status polling as a fallback. Uses the no-ads key.
 */
export async function startEmojiGeneration(
  prompt: string,
  opts?: { userAgent?: string; callbackUrl?: string },
): Promise<string> {
  const key = config.KLIPY_API_KEY_NOADS || config.KLIPY_API_KEY_ADS;
  if (!key) throw new Error('Klipy is not configured');

  const base = `${config.KLIPY_BASE_URL}/api/v1/${key}/emojis`;
  const body: Record<string, string> = { prompt };
  if (opts?.callbackUrl) body.callback_url = opts.callbackUrl;

  const startRes = await fetch(`${base}/generate`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': opts?.userAgent || 'HarmonyFederation/1.0',
    },
    body: JSON.stringify(body),
  });
  if (!startRes.ok) {
    throw new Error(`Klipy generation request failed (${startRes.status})`);
  }
  const startPayload: any = await startRes.json();
  const id = startPayload?.data?.id ?? startPayload?.id;
  if (!id || typeof id !== 'string') {
    throw new Error('Klipy did not return a generation id');
  }
  return id;
}

/**
 * Check the status of a generation by id. Returns `processing` until Klipy has
 * an image, `success` with the downloaded bytes when ready, or `failed`.
 * Used as the fallback path when a webhook callback doesn't arrive.
 */
export async function fetchGenerationStatus(
  id: string,
  opts?: { userAgent?: string },
): Promise<GenerationStatus> {
  const key = config.KLIPY_API_KEY_NOADS || config.KLIPY_API_KEY_ADS;
  if (!key) throw new Error('Klipy is not configured');

  const userAgent = opts?.userAgent || 'HarmonyFederation/1.0';
  const base = `${config.KLIPY_BASE_URL}/api/v1/${key}/emojis`;
  const statusRes = await fetch(`${base}/generated/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': userAgent },
  });
  if (!statusRes.ok) return { state: 'processing' };

  const payload: any = await statusRes.json();
  return parseGenerationPayload(payload, userAgent);
}

/**
 * Normalize a Klipy generation payload (from either the status endpoint or a
 * webhook callback) into a GenerationStatus. Exported so the callback route can
 * reuse the exact same extraction logic.
 */
export async function parseGenerationPayload(
  payload: any,
  userAgent = 'HarmonyFederation/1.0',
): Promise<GenerationStatus> {
  const status = String(payload?.status ?? payload?.data?.status ?? '').toLowerCase();
  if (status === 'failed' || status === 'error') return { state: 'failed' };

  const image = await extractGeneratedImage(payload, userAgent);
  if (image) return { state: 'success', image };
  return { state: 'processing' };
}

/** Map a Klipy image URL extension to a mime type (fallback when no header). */
function mimeFromUrl(url: string): string | undefined {
  const ext = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    default: return undefined;
  }
}

/**
 * Pull the finished image out of a Klipy generation status payload, tolerating
 * the several shapes their API can return. Returns null when the job hasn't
 * produced an image yet (caller keeps polling).
 */
async function extractGeneratedImage(
  payload: any,
  userAgent: string,
): Promise<GeneratedEmoji | null> {
  const item = payload?.data?.result ?? payload?.result ?? payload?.data ?? payload;
  if (!item || typeof item !== 'object') return null;

  // 1) Inline base64 (if Klipy ever returns it directly).
  const b64: unknown =
    item?.base64_encoded ?? item?.result?.base64_encoded ?? item?.file?.base64_encoded;
  if (typeof b64 === 'string' && b64) {
    const buffer = Buffer.from(b64, 'base64');
    if (buffer.length) {
      const mimeType = String(item?.mime_type ?? item?.file?.mime_type ?? 'image/png');
      return { buffer, mimeType };
    }
  }

  // 2) Hosted file URL — Klipy's standard `file` size/format structure, or a
  // plain url/preview_url. Prefer lossless/transparent formats for emoji.
  const file = item?.file as KlipyFile | undefined;
  const imageUrl =
    pickUrl(file, DISPLAY_SIZES, 'png') ||
    pickUrl(file, DISPLAY_SIZES, 'webp') ||
    pickUrl(file, DISPLAY_SIZES, 'gif') ||
    (typeof item?.url === 'string' && /^https?:\/\//.test(item.url) ? item.url : undefined) ||
    (typeof item?.preview_url === 'string' ? item.preview_url : undefined);

  if (!imageUrl) return null;

  const imgRes = await fetch(imageUrl, { headers: { 'User-Agent': userAgent } });
  if (!imgRes.ok) {
    throw new Error(`Failed to download generated emoji (${imgRes.status})`);
  }
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  if (!buffer.length) throw new Error('Klipy returned an unreadable image');
  const headerMime = imgRes.headers.get('content-type')?.split(';')[0]?.trim();
  const mimeType = headerMime || mimeFromUrl(imageUrl) || 'image/png';
  return { buffer, mimeType };
}

/** Klipy suggestion payloads vary; pull plain strings out of common shapes. */
function extractSuggestionStrings(payload: any): string[] {
  const data = payload?.data ?? payload;
  const arr: any[] = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  const out: string[] = [];
  for (const entry of arr) {
    if (typeof entry === 'string') out.push(entry);
    else if (entry && typeof entry === 'object') {
      const term = entry.term ?? entry.text ?? entry.title ?? entry.name ?? entry.query;
      if (typeof term === 'string') out.push(term);
    }
  }
  return out.slice(0, 8);
}

export default KlipyService;
