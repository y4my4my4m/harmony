/**
 * Link previews of posts on X, Instagram and Bluesky: author, text, date, every photo and
 * video, and the quoted post.
 *
 * Sources:
 *   X          api.fxtwitter.com/<user>/status/<id>; x.com serves crawlers a login wall.
 *   Instagram  www.instagram.com/p/<code>/ as Meta's crawler: that user agent, and no other
 *              (Discordbot, TelegramBot, Harmony's combined agent), gets a page carrying the
 *              media JSON. Then embed-fixer mirrors as Discordbot, in INSTAGRAM_EMBED_MIRRORS
 *              order; a mirror contributes CDN URLs and the caption, never its own bytes,
 *              names or pages. Last, the og:image Instagram serves any crawler.
 *   Bluesky    public.api.bsky.app app.bsky.feed.getPostThread; video files as blobs of the
 *              author's PDS, found through plc.directory.
 *
 * Media URLs in a preview are the CDN's own where the browser can load them, else the
 * instance's (utils/embedMediaHosts.ts).
 */

import NodeCache from 'node-cache';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';
import { safeFetch } from '../utils/ssrfProtection.js';
import { parseMetaTags } from '../utils/htmlMeta.js';
import {
  cdnUrlExpiresAt,
  httpsUrl,
  instagramMediaUrl,
  isBlueskyCdnUrl,
  isBlueskyPdsHost,
  isInstagramCdnUrl,
  isTwitterImageUrl,
  isTwitterVideoUrl,
  relayMediaUrl,
} from '../utils/embedMediaHosts.js';

export type SocialPlatform = 'x' | 'instagram' | 'bluesky';

/** One photo, video or GIF of a post. */
export interface EmbedMedia {
  /** `gif`: a silent looping clip (X stores GIFs as MP4). */
  type: 'image' | 'video' | 'gif';
  url: string;
  width?: number;
  height?: number;
  /** Still frame of a video or GIF. */
  poster?: string;
  /** Seconds. */
  duration?: number;
  alt?: string;
  /** Container type when it is not MP4 (an HLS playlist plays in WebKit only). */
  mime?: string;
  /** HLS playlist of the same video, for WebKit: it plays no file served without byte ranges. */
  hls?: string;
}

export interface EmbedSocialAuthor {
  name?: string;
  /** With the leading @. */
  handle?: string;
  avatar?: string;
  url?: string;
}

export interface EmbedSocialQuote {
  url: string;
  author: EmbedSocialAuthor;
  text?: string;
  /** ISO 8601. */
  publishedAt?: string;
  media?: EmbedMedia[];
}

/** The post a preview shows. Its media is EmbedPayload.media. */
export interface EmbedSocialPost {
  platform: SocialPlatform;
  url: string;
  author: EmbedSocialAuthor;
  text?: string;
  /** ISO 8601. */
  publishedAt?: string;
  quote?: EmbedSocialQuote;
}

/** The fields a social post sets on EmbedPayload. */
export interface SocialPreview {
  title?: string;
  description?: string;
  siteName: string;
  image?: string;
  width?: number;
  height?: number;
  icon?: string;
  video?: { url: string; type?: string; width?: number; height?: number };
  canonicalUrl?: string;
  media: EmbedMedia[];
  social: EmbedSocialPost;
}

const API_USER_AGENT = 'HarmonyFederation/1.0 (link preview)';
/** Meta's link crawler, as Facebook sends it. */
export const META_CRAWLER_USER_AGENT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
/** Discord's link crawler; embed-fixer mirrors answer it with their embed. */
export const DISCORDBOT_USER_AGENT = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';

const TEXT_LIMIT = 4000;
const DESCRIPTION_LIMIT = 500;
const MEDIA_LIMIT = 20;
/** Highest X video bitrate picked, in bits/s: 720p. Higher variants cost the relay more. */
const MAX_TWEET_BITRATE = 2_500_000;

const clip = (text: unknown, limit: number): string | undefined =>
  typeof text === 'string' && text.trim() ? text.trim().slice(0, limit) : undefined;

const positive = (n: unknown): number | undefined => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

const isoFromSeconds = (s: unknown): string | undefined => {
  const v = positive(s);
  return v ? new Date(v * 1000).toISOString() : undefined;
};

const isoFromString = (s: unknown): string | undefined => {
  if (typeof s !== 'string') return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

function titleOf(author: EmbedSocialAuthor): string | undefined {
  if (author.name && author.handle) return `${author.name} (${author.handle})`;
  return author.name || author.handle;
}

/** The fields shared by every platform, from the post and its media. */
function previewFields(social: EmbedSocialPost, media: EmbedMedia[], siteName: string): SocialPreview {
  const first = media[0];
  const firstVideo = media.find((m) => (m.type === 'video' || m.type === 'gif') && !m.mime);
  return {
    title: titleOf(social.author),
    description: social.text?.slice(0, DESCRIPTION_LIMIT),
    siteName,
    image: first ? (first.type === 'image' ? first.url : first.poster) : undefined,
    width: first?.width,
    height: first?.height,
    icon: social.author.avatar,
    ...(firstVideo ? {
      video: { url: firstVideo.url, type: 'video/mp4', width: firstVideo.width, height: firstVideo.height },
    } : {}),
    media,
    social,
  };
}

// ---------------------------------------------------------------------------
// Post links

const X_HOSTS = new Set([
  'x.com', 'twitter.com',
  'vxtwitter.com', 'fxtwitter.com', 'fixupx.com', 'fixvx.com',
  'twittpr.com', 'girlcockx.com', 'nitter.net', 'xcancel.com',
]);

const INSTAGRAM_HOSTS = new Set([
  'instagram.com', 'instagr.am',
  'kkinstagram.com', 'ddinstagram.com', 'uuinstagram.com', 'eeinstagram.com',
  'vxinstagram.com', 'instagramez.com', 'fxstagram.com',
]);

const BLUESKY_HOSTS = new Set(['bsky.app', 'fxbsky.app', 'bskye.app', 'bskx.app', 'vxbsky.app']);

const hostOf = (url: URL) => url.hostname.toLowerCase().replace(/^(www|mobile|m|d|g)\./, '');

/** x.com/<user>/status/<id> and the same path on mirrors. */
export function parseTweetUrl(raw: string): { user: string; id: string } | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (!X_HOSTS.has(hostOf(url))) return null;
  const m = url.pathname.match(/^\/([A-Za-z0-9_]{1,15}|i)\/status(?:es)?\/(\d{1,20})/);
  return m ? { user: m[1], id: m[2] } : null;
}

/** instagram.com/[<user>/](p|reel|reels|tv)/<code> and the same path on mirrors. */
export function parseInstagramUrl(raw: string): { code: string } | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (!INSTAGRAM_HOSTS.has(hostOf(url))) return null;
  const m = url.pathname.match(/^\/(?:[A-Za-z0-9._]{1,30}\/)?(?:p|reels?|tv)\/([A-Za-z0-9_-]{5,40})(?:\/|$)/);
  return m ? { code: m[1] } : null;
}

/** bsky.app/profile/<handle or did>/post/<rkey> and the same path on mirrors. */
export function parseBlueskyUrl(raw: string): { actor: string; rkey: string } | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (!BLUESKY_HOSTS.has(hostOf(url))) return null;
  const m = url.pathname.match(/^\/profile\/([^/]+)\/post\/([a-z0-9]{2,32})\/?$/i);
  if (!m) return null;
  let actor: string;
  try { actor = decodeURIComponent(m[1]).toLowerCase(); } catch { return null; }
  if (!/^(did:(plc|web):[a-z0-9.:-]+|[a-z0-9-]+(\.[a-z0-9-]+)+)$/.test(actor)) return null;
  return { actor, rkey: m[2] };
}

export function socialPlatformOf(url: string): SocialPlatform | null {
  if (parseTweetUrl(url)) return 'x';
  if (parseInstagramUrl(url)) return 'instagram';
  if (parseBlueskyUrl(url)) return 'bluesky';
  return null;
}

/** The preview of a post link, or null when its platform has nothing for it. */
export async function fetchSocialPreview(url: string): Promise<SocialPreview | null> {
  const tweet = parseTweetUrl(url);
  if (tweet) return fetchTweetPreview(tweet.user, tweet.id);
  const instagram = parseInstagramUrl(url);
  if (instagram) return fetchInstagramPreview(instagram.code);
  const bluesky = parseBlueskyUrl(url);
  if (bluesky) return fetchBlueskyPreview(bluesky.actor, bluesky.rkey);
  return null;
}

async function getJson(url: string, timeoutMs = 8000): Promise<any | null> {
  const res = await safeFetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': API_USER_AGENT },
    timeoutMs,
    maxBodyBytes: 3_000_000,
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// X (FxTwitter)

/** The MP4 a tweet video plays: H.264, the highest bitrate up to MAX_TWEET_BITRATE. */
export function pickTweetVideo(item: any): string | undefined {
  const formats: any[] = Array.isArray(item?.formats) ? item.formats
    : Array.isArray(item?.variants) ? item.variants.map((v: any) => ({ ...v, container: v.content_type === 'video/mp4' ? 'mp4' : undefined }))
      : [];
  const mp4 = formats
    .filter((f) => f?.container === 'mp4' && (!f.codec || f.codec === 'h264') && isTwitterVideoUrl(f.url))
    .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
  const fitting = mp4.find((f) => (Number(f.bitrate) || 0) <= MAX_TWEET_BITRATE);
  const chosen = fitting ?? mp4[mp4.length - 1];
  if (chosen) return chosen.url;
  return isTwitterVideoUrl(item?.url) ? item.url : undefined;
}

export function tweetMedia(media: any): EmbedMedia[] {
  const all: any[] = Array.isArray(media?.all) ? media.all
    : [...(Array.isArray(media?.photos) ? media.photos : []), ...(Array.isArray(media?.videos) ? media.videos : [])];
  const out: EmbedMedia[] = [];
  for (const item of all) {
    if (out.length >= MEDIA_LIMIT) break;
    const width = positive(item?.width);
    const height = positive(item?.height);
    const alt = clip(item?.altText, 1000);
    if (item?.type === 'photo') {
      if (isTwitterImageUrl(item.url)) out.push({ type: 'image', url: item.url, width, height, ...(alt ? { alt } : {}) });
      continue;
    }
    if (item?.type === 'video' || item?.type === 'gif') {
      const file = pickTweetVideo(item);
      if (!file) continue;
      const gif = item.type === 'gif';
      const duration = gif ? undefined : positive(item.duration);
      out.push({
        type: gif ? 'gif' : 'video',
        url: relayMediaUrl(file),
        width,
        height,
        ...(isTwitterImageUrl(item.thumbnail_url) ? { poster: item.thumbnail_url } : {}),
        ...(duration ? { duration } : {}),
        ...(alt ? { alt } : {}),
      });
    }
  }
  return out;
}

function tweetAuthor(author: any): EmbedSocialAuthor {
  const handle = typeof author?.screen_name === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(author.screen_name)
    ? author.screen_name : undefined;
  return {
    name: clip(author?.name, 100),
    handle: handle ? `@${handle}` : undefined,
    avatar: isTwitterImageUrl(author?.avatar_url) ? author.avatar_url : undefined,
    url: handle ? `https://x.com/${handle}` : undefined,
  };
}

const tweetUrl = (tweet: any): string | undefined => {
  const url = httpsUrl(tweet?.url);
  return url && (url.hostname === 'x.com' || url.hostname === 'twitter.com') ? url.href : undefined;
};

async function fetchTweetPreview(user: string, id: string): Promise<SocialPreview | null> {
  let data: any;
  try {
    data = await getJson(`https://api.fxtwitter.com/${user}/status/${id}`);
  } catch (err) {
    logger.debug(`FxTwitter lookup failed for ${user}/${id}: ${(err as Error).message}`);
    return null;
  }
  const tweet = data?.tweet;
  if (data?.code !== 200 || !tweet) return null;

  const author = tweetAuthor(tweet.author);
  const social: EmbedSocialPost = {
    platform: 'x',
    url: tweetUrl(tweet) ?? `https://x.com/${user}/status/${id}`,
    author,
    text: clip(tweet.text, TEXT_LIMIT),
    publishedAt: isoFromSeconds(tweet.created_timestamp),
  };
  const quote = tweet.quote;
  if (quote && typeof quote === 'object' && quote.type !== 'tombstone' && tweetUrl(quote)) {
    const media = tweetMedia(quote.media);
    social.quote = {
      url: tweetUrl(quote)!,
      author: tweetAuthor(quote.author),
      text: clip(quote.text, TEXT_LIMIT),
      publishedAt: isoFromSeconds(quote.created_timestamp),
      ...(media.length ? { media } : {}),
    };
  }
  return previewFields(social, tweetMedia(tweet.media), 'X (Twitter)');
}

// ---------------------------------------------------------------------------
// Instagram

export interface InstagramItem {
  type: 'image' | 'video';
  /** CDN URL of the photo, or of the video's still. */
  image?: string;
  /** CDN URL of the video file. */
  video?: string;
  width?: number;
  height?: number;
  duration?: number;
  alt?: string;
}

export interface InstagramPost {
  code: string;
  items: InstagramItem[];
  username?: string;
  fullName?: string;
  avatar?: string;
  caption?: string;
  /** Epoch seconds. */
  takenAt?: number;
  /** Epoch ms the earliest CDN URL above stops working. */
  expiresAt: number;
}

/** Longest a resolved post is reused; Meta CDN URLs live a day or more. */
const INSTAGRAM_CACHE_MAX_S = 30 * 60;
/** A resolved post is dropped this long before its earliest CDN URL expires. */
const INSTAGRAM_EXPIRY_MARGIN_S = 5 * 60;
/** A post no source could read is not asked for again for this long. */
const INSTAGRAM_MISS_TTL_S = 5 * 60;
/** Assumed lifetime of CDN URLs without an `oe`. */
const INSTAGRAM_DEFAULT_LIFETIME_MS = 60 * 60 * 1000;
const INSTAGRAM_PAGE_TIMEOUT_MS = 8000;
const MIRROR_TIMEOUT_MS = 6000;
/** All mirrors together stop after this long. */
const MIRROR_BUDGET_MS = 15_000;
/**
 * kkinstagram redirects Discordbot to the file (reels and carousels; photo posts bounce to
 * instagram.com); uuinstagram and eeinstagram run InstaFix, whose /videos and /images paths
 * redirect to it. Probed 2026-10-22: ddinstagram.com does not resolve, instagramez.com
 * redirects to an ad network, vxinstagram.com answers 404.
 */
const DEFAULT_MIRRORS = ['kkinstagram.com', 'uuinstagram.com', 'eeinstagram.com'];

const instagramCache = new NodeCache({ checkperiod: 120, useClones: false });
const instagramInflight = new Map<string, Promise<InstagramPost | null>>();

/** INSTAGRAM_EMBED_MIRRORS as host names, in order; unset: DEFAULT_MIRRORS; empty: none. */
export function instagramMirrors(): string[] {
  const raw = config.INSTAGRAM_EMBED_MIRRORS;
  if (raw === undefined) return DEFAULT_MIRRORS;
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h));
}

function bestCandidate(candidates: unknown): { url: string; width?: number; height?: number } | undefined {
  if (!Array.isArray(candidates)) return undefined;
  const usable = candidates.filter((c) => isInstagramCdnUrl(c?.url));
  const fitting = usable
    .filter((c) => (positive(c.width) ?? 0) <= 1440)
    .sort((a, b) => (positive(b.width) ?? 0) - (positive(a.width) ?? 0));
  const c = fitting[0] ?? usable[0];
  return c ? { url: c.url, width: positive(c.width), height: positive(c.height) } : undefined;
}

function instagramItem(node: any): InstagramItem | null {
  const image = bestCandidate(node?.image_versions2?.candidates);
  const video = Array.isArray(node?.video_versions)
    ? node.video_versions.find((v: any) => isInstagramCdnUrl(v?.url))?.url as string | undefined
    : undefined;
  const width = positive(node?.original_width) ?? image?.width;
  const height = positive(node?.original_height) ?? image?.height;
  const alt = clip(node?.accessibility_caption, 1000);
  const common = { width, height, ...(alt ? { alt } : {}) };
  if (video) {
    const duration = positive(node?.video_duration);
    return { type: 'video', video, image: image?.url, ...common, ...(duration ? { duration } : {}) };
  }
  return image ? { type: 'image', image: image.url, ...common } : null;
}

function findMediaNode(root: unknown, code: string): any | null {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  let visited = 0;
  while (stack.length && visited++ < 200_000) {
    const { node, depth } = stack.pop()!;
    if (!node || typeof node !== 'object' || depth > 80) continue;
    const obj = node as Record<string, any>;
    if (!Array.isArray(node) && obj.code === code && (obj.image_versions2 || obj.carousel_media || obj.video_versions)) {
      return obj;
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') stack.push({ node: value, depth: depth + 1 });
    }
  }
  return null;
}

function earliestExpiry(urls: Array<string | undefined>): number {
  const times = urls.map(cdnUrlExpiresAt).filter((t): t is number => t !== undefined);
  return times.length ? Math.min(...times) : Date.now() + INSTAGRAM_DEFAULT_LIFETIME_MS;
}

function withExpiry(post: Omit<InstagramPost, 'expiresAt'>): InstagramPost {
  const urls = post.items.flatMap((i) => [i.image, i.video]);
  return { ...post, expiresAt: earliestExpiry([...urls, post.avatar]) };
}

/**
 * The post `code` from an instagram.com page served to Meta's crawler: the media object in
 * one of its <script type="application/json"> blocks. Null when the page carries none.
 */
export function parseInstagramPage(html: string, code: string): InstagramPost | null {
  const needle = `"code":"${code}"`;
  for (const block of html.matchAll(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!block[1].includes(needle)) continue;
    let root: unknown;
    try { root = JSON.parse(block[1]); } catch { continue; }
    const node = findMediaNode(root, code);
    if (!node) continue;
    const children = Array.isArray(node.carousel_media) && node.carousel_media.length ? node.carousel_media : [node];
    const items = children.map(instagramItem).filter((i: InstagramItem | null): i is InstagramItem => !!i).slice(0, MEDIA_LIMIT);
    if (!items.length) return null;
    const user = node.user ?? node.owner ?? {};
    const username = typeof user.username === 'string' && /^[A-Za-z0-9._]{1,30}$/.test(user.username) ? user.username : undefined;
    return withExpiry({
      code,
      items,
      username,
      fullName: clip(user.full_name, 100),
      avatar: isInstagramCdnUrl(user.profile_pic_url) ? user.profile_pic_url : undefined,
      caption: clip(node.caption?.text, TEXT_LIMIT),
      takenAt: positive(node.taken_at),
    });
  }
  return null;
}

interface InstagramPageResult {
  post: InstagramPost | null;
  /** og:image of the page: a square crop of the first photo or video still. */
  ogImage?: string;
}

async function fromInstagram(code: string): Promise<InstagramPageResult> {
  try {
    const res = await safeFetch(`https://www.instagram.com/p/${code}/`, {
      headers: { 'User-Agent': META_CRAWLER_USER_AGENT, Accept: 'text/html', 'Accept-Language': 'en' },
      timeoutMs: INSTAGRAM_PAGE_TIMEOUT_MS,
      maxBodyBytes: 4_000_000,
      maxRedirects: 2,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { post: null };
    }
    const html = await res.text();
    const post = parseInstagramPage(html, code);
    const headEnd = html.search(/<\/head>/i);
    const meta = parseMetaTags(headEnd >= 0 ? html.slice(0, headEnd) : html);
    const og = meta.get('og:image') ?? meta.get('twitter:image');
    return { post, ogImage: isInstagramCdnUrl(og) ? og : undefined };
  } catch (err) {
    logger.debug(`Instagram page fetch failed for ${code}: ${(err as Error).message}`);
    return { post: null };
  }
}

/** A CDN file a mirror pointed at; its type from the path (.mp4 is video). */
function cdnItem(location: string | null | undefined): InstagramItem | null {
  if (!location || !isInstagramCdnUrl(location)) return null;
  return /\.mp4$/i.test(new URL(location).pathname)
    ? { type: 'video', video: location }
    : { type: 'image', image: location };
}

async function mirrorRedirect(url: string, deadline: number): Promise<string | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const res = await safeFetch(url, {
    headers: { 'User-Agent': DISCORDBOT_USER_AGENT, Accept: 'text/html' },
    timeoutMs: Math.min(MIRROR_TIMEOUT_MS, remaining),
    maxBodyBytes: 512_000,
    followRedirects: false,
  });
  await res.body?.cancel().catch(() => {});
  if (res.status < 300 || res.status >= 400) return null;
  const location = res.headers.get('location');
  return location ? new URL(location, url).href : null;
}

/**
 * The first media of `code` from one mirror: a redirect straight to the CDN file (kkinstagram),
 * or a page whose og:video / og:image names a /videos/<code>/<n> or /images/<code>/<n> path
 * of the mirror that redirects to the CDN file (InstaFix). Caption and user name come from the
 * page; the mirror's own name and title are ignored.
 */
export async function fromMirror(host: string, code: string, deadline: number): Promise<Omit<InstagramPost, 'expiresAt'> | null> {
  const origin = `https://${host}`;
  const pageUrl = `${origin}/p/${code}/`;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const res = await safeFetch(pageUrl, {
    headers: { 'User-Agent': DISCORDBOT_USER_AGENT, Accept: 'text/html' },
    timeoutMs: Math.min(MIRROR_TIMEOUT_MS, remaining),
    maxBodyBytes: 512_000,
    followRedirects: false,
  });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    const location = res.headers.get('location');
    const item = cdnItem(location ? new URL(location, pageUrl).href : null);
    return item ? { code, items: [item] } : null;
  }
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok || !type.includes('text/html')) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const meta = parseMetaTags(await res.text());
  // code is [A-Za-z0-9_-]: no pattern metacharacter outside a class.
  const mediaPath = new RegExp(`^/(videos|images)/${code}/\\d{1,2}$`);
  let item: InstagramItem | null = null;
  for (const key of ['og:video:secure_url', 'og:video', 'twitter:player:stream', 'og:image', 'twitter:image']) {
    const value = meta.get(key);
    if (!value) continue;
    let target: URL;
    try { target = new URL(value, `${origin}/`); } catch { continue; }
    if (target.origin === origin && mediaPath.test(target.pathname) && !target.search) {
      item = cdnItem(await mirrorRedirect(target.href, deadline));
    } else {
      item = cdnItem(target.href);
    }
    if (item) break;
  }
  if (!item) return null;
  const handle = meta.get('twitter:title')?.match(/^@([A-Za-z0-9._]{1,30})$/)?.[1];
  return { code, items: [item], username: handle, caption: clip(meta.get('og:description'), TEXT_LIMIT) };
}

async function fromMirrors(code: string): Promise<Omit<InstagramPost, 'expiresAt'> | null> {
  const deadline = Date.now() + MIRROR_BUDGET_MS;
  for (const host of instagramMirrors()) {
    if (Date.now() >= deadline) break;
    try {
      const found = await fromMirror(host, code, deadline);
      if (found) return found;
    } catch (err) {
      logger.debug(`Instagram mirror ${host} failed for ${code}: ${(err as Error).message}`);
    }
  }
  return null;
}

async function resolveInstagramUncached(code: string): Promise<InstagramPost | null> {
  const page = await fromInstagram(code);
  if (page.post) return page.post;
  const mirrored = await fromMirrors(code);
  if (mirrored) {
    const [first] = mirrored.items;
    if (first.type === 'video' && !first.image && page.ogImage) first.image = page.ogImage;
    return withExpiry(mirrored);
  }
  return page.ogImage ? withExpiry({ code, items: [{ type: 'image', image: page.ogImage }] }) : null;
}

/** True when `code` is resolved (or known unreadable) in the cache. */
export function isInstagramPostCached(code: string): boolean {
  return instagramCache.has(code);
}

/** Uncached posts read at once, instance-wide; further lookups wait their turn. */
const INSTAGRAM_LOOKUP_SLOTS = 4;
let instagramLookups = 0;
const instagramLookupQueue: Array<() => void> = [];

async function withLookupSlot<T>(task: () => Promise<T>): Promise<T> {
  if (instagramLookups >= INSTAGRAM_LOOKUP_SLOTS) {
    await new Promise<void>((resolve) => instagramLookupQueue.push(resolve));
  } else {
    instagramLookups++;
  }
  try {
    return await task();
  } finally {
    const next = instagramLookupQueue.shift();
    if (next) next();
    else instagramLookups--;
  }
}

/**
 * The post `code` with CDN URLs that work now. Cached until INSTAGRAM_EXPIRY_MARGIN_S before
 * its earliest URL expires, at most INSTAGRAM_CACHE_MAX_S; concurrent callers share one fetch.
 */
export async function resolveInstagramPost(code: string): Promise<InstagramPost | null> {
  const cached = instagramCache.get<InstagramPost | null>(code);
  if (cached !== undefined) return cached;
  const pending = instagramInflight.get(code);
  if (pending) return pending;
  const run = withLookupSlot(() => resolveInstagramUncached(code))
    .catch((err) => {
      logger.debug(`Instagram resolve failed for ${code}: ${(err as Error).message}`);
      return null;
    })
    .then((post) => {
      if (post) {
        const ttl = Math.min(INSTAGRAM_CACHE_MAX_S, Math.floor((post.expiresAt - Date.now()) / 1000) - INSTAGRAM_EXPIRY_MARGIN_S);
        if (ttl > 0) instagramCache.set(code, post, ttl);
      } else {
        instagramCache.set(code, null, INSTAGRAM_MISS_TTL_S);
      }
      return post;
    })
    .finally(() => instagramInflight.delete(code));
  instagramInflight.set(code, run);
  return run;
}

/** Drops cached posts. Tests only. */
export function clearInstagramCache(): void {
  instagramCache.flushAll();
}

async function fetchInstagramPreview(code: string): Promise<SocialPreview | null> {
  const post = await resolveInstagramPost(code);
  if (!post) return null;
  const media: EmbedMedia[] = post.items.map((item, i) => {
    const common = {
      ...(item.width ? { width: item.width } : {}),
      ...(item.height ? { height: item.height } : {}),
      ...(item.alt ? { alt: item.alt } : {}),
    };
    return item.type === 'video'
      ? {
        type: 'video' as const,
        url: instagramMediaUrl(code, `${i}`),
        ...(item.image ? { poster: instagramMediaUrl(code, `${i}/poster`) } : {}),
        ...(item.duration ? { duration: item.duration } : {}),
        ...common,
      }
      : { type: 'image' as const, url: instagramMediaUrl(code, `${i}`), ...common };
  });
  const social: EmbedSocialPost = {
    platform: 'instagram',
    url: `https://www.instagram.com/p/${code}/`,
    author: {
      name: post.fullName,
      handle: post.username ? `@${post.username}` : undefined,
      avatar: post.avatar ? instagramMediaUrl(code, 'avatar') : undefined,
      url: post.username ? `https://www.instagram.com/${post.username}/` : undefined,
    },
    text: post.caption,
    publishedAt: isoFromSeconds(post.takenAt),
  };
  return { ...previewFields(social, media, 'Instagram'), canonicalUrl: social.url };
}

/**
 * The CDN URL of one media of `code` now: item `n`'s file, its still (`n/poster`), or the
 * author's picture (`avatar`). Undefined when the post or the slot is not there.
 */
export async function instagramMediaTarget(code: string, slot: string): Promise<{ url: string; expiresAt: number } | undefined> {
  const post = await resolveInstagramPost(code);
  if (!post) return undefined;
  let url: string | undefined;
  if (slot === 'avatar') {
    url = post.avatar;
  } else {
    const m = slot.match(/^(\d{1,2})(\/poster)?$/);
    const item = m ? post.items[Number(m[1])] : undefined;
    if (item) url = m![2] ? item.image : (item.type === 'video' ? item.video : item.image);
  }
  return url && isInstagramCdnUrl(url) ? { url, expiresAt: cdnUrlExpiresAt(url) ?? post.expiresAt } : undefined;
}

// ---------------------------------------------------------------------------
// Bluesky

const BSKY_APPVIEW = 'https://public.api.bsky.app/xrpc';
const pdsCache = new NodeCache({ stdTTL: 24 * 60 * 60, checkperiod: 600, useClones: false });

/** Seconds a failed plc.directory lookup (timeout, error status) is remembered. */
const PDS_RETRY_TTL = 5 * 60;

/** The PDS of a did:plc account, from plc.directory; Bluesky-run PDS hosts only. */
async function blueskyPds(did: string): Promise<string | null> {
  if (!/^did:plc:[a-z2-7]{24}$/.test(did)) return null;
  const cached = pdsCache.get<string | null>(did);
  if (cached !== undefined) return cached;
  let doc: any;
  try {
    doc = await getJson(`https://plc.directory/${did}`, 5000);
  } catch (err) {
    logger.debug(`PLC lookup failed for ${did}: ${(err as Error).message}`);
  }
  if (!doc) {
    pdsCache.set(did, null, PDS_RETRY_TTL);
    return null;
  }
  const service = Array.isArray(doc.service)
    ? doc.service.find((s: any) => s?.id === '#atproto_pds' || s?.type === 'AtprotoPersonalDataServer')
    : undefined;
  const endpoint = httpsUrl(service?.serviceEndpoint);
  const pds = endpoint && isBlueskyPdsHost(endpoint.hostname) && (endpoint.pathname === '/' || endpoint.pathname === '')
    ? endpoint.origin
    : null;
  pdsCache.set(did, pds);
  return pds;
}

function aspect(view: any): { width?: number; height?: number } {
  const width = positive(view?.aspectRatio?.width);
  const height = positive(view?.aspectRatio?.height);
  return width && height ? { width, height } : {};
}

async function blueskyMedia(embed: any, did: string | undefined): Promise<EmbedMedia[]> {
  switch (embed?.$type) {
    case 'app.bsky.embed.images#view':
    case 'app.bsky.embed.gallery#view': {
      const images: any[] = Array.isArray(embed.images) ? embed.images : Array.isArray(embed.items) ? embed.items : [];
      return images
        .filter((im) => isBlueskyCdnUrl(im?.fullsize))
        .slice(0, MEDIA_LIMIT)
        .map((im) => {
          const alt = clip(im.alt, 1000);
          return { type: 'image' as const, url: im.fullsize, ...aspect(im), ...(alt ? { alt } : {}) };
        });
    }
    case 'app.bsky.embed.video#view': {
      const playlist = isBlueskyCdnUrl(embed.playlist) ? embed.playlist as string : undefined;
      const cid = typeof embed.cid === 'string' && /^b[a-z2-7]{20,100}$/.test(embed.cid) ? embed.cid : undefined;
      const pds = did && cid ? await blueskyPds(did) : null;
      let url: string | undefined;
      let mime: string | undefined;
      let hls: string | undefined;
      if (pds && did && cid) {
        const blob = new URL(`${pds}/xrpc/com.atproto.sync.getBlob`);
        blob.searchParams.set('did', did);
        blob.searchParams.set('cid', cid);
        url = relayMediaUrl(blob.href);
        hls = playlist;
      } else if (playlist) {
        url = playlist;
        mime = 'application/vnd.apple.mpegurl';
      }
      if (!url) return [];
      const alt = clip(embed.alt, 1000);
      return [{
        type: 'video',
        url,
        ...aspect(embed),
        ...(isBlueskyCdnUrl(embed.thumbnail) ? { poster: embed.thumbnail } : {}),
        ...(alt ? { alt } : {}),
        ...(mime ? { mime } : {}),
        ...(hls ? { hls } : {}),
      }];
    }
    case 'app.bsky.embed.recordWithMedia#view':
      return blueskyMedia(embed.media, did);
    default:
      return [];
  }
}

function blueskyAuthor(author: any): EmbedSocialAuthor {
  const handle = typeof author?.handle === 'string' && /^[a-z0-9.-]+$/i.test(author.handle) && author.handle !== 'handle.invalid'
    ? author.handle : undefined;
  return {
    name: clip(author?.displayName, 100) ?? handle,
    handle: handle ? `@${handle}` : undefined,
    avatar: isBlueskyCdnUrl(author?.avatar) ? author.avatar : undefined,
    url: handle ? `https://bsky.app/profile/${handle}` : undefined,
  };
}

function blueskyPostUrl(uri: unknown, author: any): string | undefined {
  const rkey = typeof uri === 'string' ? uri.match(/\/app\.bsky\.feed\.post\/([a-z0-9]+)$/i)?.[1] : undefined;
  const who = typeof author?.handle === 'string' && author.handle !== 'handle.invalid' ? author.handle : author?.did;
  return rkey && typeof who === 'string' ? `https://bsky.app/profile/${who}/post/${rkey}` : undefined;
}

async function blueskyQuote(embed: any): Promise<EmbedSocialQuote | undefined> {
  const view = embed?.$type === 'app.bsky.embed.record#view' ? embed.record
    : embed?.$type === 'app.bsky.embed.recordWithMedia#view' ? embed.record?.record
      : undefined;
  if (view?.$type !== 'app.bsky.embed.record#viewRecord') return undefined;
  const url = blueskyPostUrl(view.uri, view.author);
  if (!url) return undefined;
  const nested = Array.isArray(view.embeds) ? view.embeds[0] : undefined;
  const media = nested ? await blueskyMedia(nested, view.author?.did) : [];
  return {
    url,
    author: blueskyAuthor(view.author),
    text: clip(view.value?.text, TEXT_LIMIT),
    publishedAt: isoFromString(view.value?.createdAt),
    ...(media.length ? { media } : {}),
  };
}

async function fetchBlueskyPreview(actor: string, rkey: string): Promise<SocialPreview | null> {
  let data: any;
  try {
    const uri = `at://${actor}/app.bsky.feed.post/${rkey}`;
    data = await getJson(`${BSKY_APPVIEW}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=0`);
  } catch (err) {
    logger.debug(`Bluesky lookup failed for ${actor}/${rkey}: ${(err as Error).message}`);
    return null;
  }
  const post = data?.thread?.$type === 'app.bsky.feed.defs#threadViewPost' ? data.thread.post : null;
  if (!post) return null;
  const did = typeof post.author?.did === 'string' ? post.author.did : undefined;
  const social: EmbedSocialPost = {
    platform: 'bluesky',
    url: blueskyPostUrl(post.uri, post.author) ?? `https://bsky.app/profile/${actor}/post/${rkey}`,
    author: blueskyAuthor(post.author),
    text: clip(post.record?.text, TEXT_LIMIT),
    publishedAt: isoFromString(post.record?.createdAt),
  };
  const quote = await blueskyQuote(post.embed);
  if (quote) social.quote = quote;
  return previewFields(social, await blueskyMedia(post.embed, did), 'Bluesky');
}
