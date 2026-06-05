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
export type GifMediaType = 'gifs' | 'stickers';

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
}

// Size preference order when flattening Klipy's per-size `file` object.
const DISPLAY_SIZES = ['md', 'hd', 'sm', 'xs'] as const;
const PREVIEW_SIZES = ['sm', 'xs', 'md', 'hd'] as const;

type KlipyFile = Record<string, Record<string, { url?: string } | undefined> | undefined>;

function pickUrl(file: KlipyFile | undefined, sizes: readonly string[], format: string): string | undefined {
  if (!file) return undefined;
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
  const gifUrl = pickUrl(file, DISPLAY_SIZES, 'gif') || raw?.url;
  if (!gifUrl) return null;

  // Stickers are transparent, so prefer formats that preserve alpha (webp/png/
  // gif) over jpg for the preview. GIFs prefer a cheap jpg/webp still.
  const previewUrl =
    mediaType === 'stickers'
      ? pickUrl(file, PREVIEW_SIZES, 'webp') ||
        pickUrl(file, PREVIEW_SIZES, 'png') ||
        pickUrl(file, PREVIEW_SIZES, 'gif') ||
        gifUrl
      : pickUrl(file, PREVIEW_SIZES, 'jpg') ||
        pickUrl(file, PREVIEW_SIZES, 'webp') ||
        pickUrl(file, PREVIEW_SIZES, 'gif') ||
        gifUrl;

  const mp4Url = pickUrl(file, DISPLAY_SIZES, 'mp4') || gifUrl;
  const webmUrl = pickUrl(file, DISPLAY_SIZES, 'webm') || mp4Url;

  const itemUrl =
    typeof raw?.itemurl === 'string'
      ? raw.itemurl
      : typeof raw?.item_url === 'string'
        ? raw.item_url
        : undefined;

  return {
    kind: 'gif',
    id: String(raw?.id ?? raw?.slug ?? gifUrl),
    slug: raw?.slug,
    title: raw?.title || undefined,
    itemUrl,
    media_formats: {
      gif: { url: gifUrl },
      gifpreview: { url: previewUrl },
      mp4: { url: mp4Url },
      webm: { url: webmUrl },
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
    const path = `${mediaType}/${opts.kind === 'search' ? 'search' : 'trending'}`;
    const url = new URL(`${config.KLIPY_BASE_URL}/api/v1/${key}/${path}`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('customer_id', opts.customerId);
    if (opts.kind === 'search' && opts.query) url.searchParams.set('q', opts.query);
    if (opts.locale) url.searchParams.set('locale', opts.locale);
    url.searchParams.set('content_filter', opts.contentFilter || 'medium');

    // Ad slot sizing. Only meaningful when the ads key is in use; harmless
    // otherwise. Bounds follow Klipy's recommended 50..(device width) x 50..250.
    if (opts.withAds) {
      url.searchParams.set('ad-min-width', '50');
      url.searchParams.set('ad-max-width', '401');
      url.searchParams.set('ad-min-height', '50');
      url.searchParams.set('ad-max-height', '250');
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
}

export default KlipyService;
