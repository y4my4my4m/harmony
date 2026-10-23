import NodeCache from 'node-cache';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { SignatureService } from '../activitypub/SignatureService.js';
import { validateExternalUrl, safeFetch } from '../utils/ssrfProtection.js';
import { decodeHtmlEntities } from '../utils/contentUtils.js';
import { parseMetaTags, tagAttributes } from '../utils/htmlMeta.js';
import { fetchKlipyMediaBySlug } from './KlipyService.js';
import { fetchSocialPreview, socialPlatformOf, type EmbedMedia, type EmbedSocialPost } from './socialEmbeds.js';

export type EmbedProvider =
  | 'harmony-post' | 'fediverse-post' | 'youtube' | 'spotify' | 'reddit' | 'generic'
  | 'soundcloud' | 'apple-music' | 'bandcamp' | 'deezer' | 'tidal'
  | 'x' | 'instagram' | 'bluesky';

export type { EmbedMedia, EmbedSocialPost } from './socialEmbeds.js';

/** Hosts of provider player pages a payload may name in `player`. */
const PLAYER_HOSTS = new Set([
  'w.soundcloud.com', 'bandcamp.com', 'embed.music.apple.com', 'open.spotify.com',
  'widget.deezer.com', 'embed.tidal.com',
]);

/** An https player page on PLAYER_HOSTS, else undefined. */
export function providerPlayerUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && PLAYER_HOSTS.has(url.hostname.toLowerCase()) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export interface FediverseEmbedData {
  authorName: string;
  authorHandle: string;
  authorAvatar?: string;
  authorUrl: string;
  content: string;
  published: string;
  attachments?: Array<{
    url: string;
    mediaType?: string;
    alt?: string;
  }>;
  sensitive?: boolean;
  contentWarning?: string;
  platform?: string;
  postUrl: string;
  stats?: {
    replies?: number;
    reblogs?: number;
    favourites?: number;
  };
}

export interface EmbedPayload {
  cacheKey: string;
  url: string;
  normalizedUrl: string;
  provider: EmbedProvider;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  icon?: string;
  color?: string;
  html?: string;
  width?: number;
  height?: number;
  /** Preview is media only (GIF page etc.); clients render the image itself,
      not a link card. */
  mediaOnly?: boolean;
  /** A playable video: og:video, twitter:player:stream, or the link itself answering with
      video (embed-fixer sites redirect previewers straight to the file). */
  video?: { url: string; type?: string; width?: number; height?: number };
  /** The page could not be read. Never stored on a message; cached briefly and retried. */
  failed?: boolean;
  /** Where the link led after redirects, or the page's og:url (short links of music services). */
  canonicalUrl?: string;
  /** The provider's player page (twitter:player, og:video or oEmbed iframe), PLAYER_HOSTS only. */
  player?: { url: string; height?: number };
  /** Every photo, video and GIF of a post (X, Instagram, Bluesky), in its order. `image` and
      `video` hold the first, for clients that read only those. */
  media?: EmbedMedia[];
  /** The post of an X, Instagram or Bluesky link: author, text, date, quoted post. */
  social?: EmbedSocialPost;
  fetchedAt: string;
  expiresAt: string;
  harmony?: {
    postId: string;
    instanceDomain: string;
    visibility: string;
    isLocal: boolean;
    author?: {
      id?: string;
      username?: string;
      display_name?: string;
      domain?: string;
      avatar_url?: string | null;
      color?: string | null;
    };
  };
  fediverse?: FediverseEmbedData;
  localPostId?: string;
}

const TTL_BY_PROVIDER: Record<EmbedProvider, number> = {
  'harmony-post': 5 * 60 * 1000, // 5 minutes
  'fediverse-post': 30 * 60 * 1000, // 30 minutes
  youtube: 6 * 60 * 60 * 1000, // 6 hours
  spotify: 6 * 60 * 60 * 1000,
  reddit: 6 * 60 * 60 * 1000,
  soundcloud: 6 * 60 * 60 * 1000,
  'apple-music': 6 * 60 * 60 * 1000,
  bandcamp: 6 * 60 * 60 * 1000,
  deezer: 6 * 60 * 60 * 1000,
  tidal: 6 * 60 * 60 * 1000,
  x: 6 * 60 * 60 * 1000,
  bluesky: 6 * 60 * 60 * 1000,
  // Media URLs are the instance's stable /embed-media/instagram/... routes; the CDN URLs
  // behind them are cached apart (socialEmbeds.resolveInstagramPost).
  instagram: 30 * 60 * 1000,
  generic: 24 * 60 * 60 * 1000, // 24 hours
};

// Embed-fixer sites (vxtwitter, fxtwitter, kkinstagram, ddinstagram, fxbsky, ...) serve their
// embed, or redirect to the media file, only for the user agents of known link previewers;
// others get a stub page or a redirect to the original site. vxtwitter matches
// facebookexternalhit/1.1, kkinstagram Discordbot and TelegramBot. Harmony's own name comes
// first.
const USER_AGENT = 'Mozilla/5.0 (compatible; HarmonyLinkPreview/1.0; +https://har.mony.lol) facebookexternalhit/1.1 Discordbot/2.0 TelegramBot';
/** A page's metadata lives in <head>; the read stops there or at this many bytes. */
const HEAD_READ_LIMIT = 1024 * 1024;
const HTML_FETCH_TIMEOUT_MS = 15_000;
/** A failed preview is retried after this long. */
const FAILED_PREVIEW_TTL_MS = 5 * 60 * 1000;

export { parseMetaTags };

/**
 * The page's icon: the first <link> whose rel lists `icon` (`icon`, `shortcut icon`,
 * `alternate icon`), else an apple-touch-icon. href is read by name: GitHub's icon link
 * carries data-base-href after it, which a pattern ending in `href=` took instead (a 404).
 */
export function parseIconHref(html: string): string | undefined {
  let touch: string | undefined;
  for (const tag of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = tagAttributes(tag[1]);
    const href = attrs.href?.trim();
    if (!href) continue;
    const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('icon')) return decodeHtmlEntities(href);
    if (!touch && (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed'))) {
      touch = decodeHtmlEntities(href);
    }
  }
  return touch;
}

/** The response body up to the end of <head>, at most `limit` bytes; the rest is not read. */
async function readHead(response: Response, limit = HEAD_READ_LIMIT): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= limit || /<\/head\s*>/i.test(text)) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

// Hosts whose preview is media only (GIF sites). Combined with a .gif
// og:image heuristic to set EmbedPayload.mediaOnly.
const GIF_PAGE_HOSTS = new Set(['tenor.com', 'giphy.com', 'klipy.com']);

// Wikimedia projects store still photos as GIF; their .gif images are no GIF page.
const WIKIMEDIA_HOST = /(^|\.)(wikipedia|wikimedia|wiktionary|wikiquote|wikibooks|wikisource|wikivoyage|wikinews|wikiversity|wikidata)\.org$/;

const NON_AP_DOMAINS = new Set([
  'google.com', 'google.co.jp', 'google.co.uk', 'google.de', 'google.fr',
  'googleapis.com', 'gstatic.com',
  'facebook.com', 'fb.com', 'fbcdn.net',
  'instagram.com',
  'x.com', 'twitter.com', 't.co',
  'tiktok.com',
  'github.com', 'githubusercontent.com',
  'wikipedia.org', 'wikimedia.org',
  'twitch.tv',
  'linkedin.com',
  'imgur.com',
  'discord.com', 'discord.gg', 'discordapp.com',
  'medium.com',
  'notion.so', 'notion.site',
  'stackoverflow.com', 'stackexchange.com',
  'amazon.com', 'amzn.to',
  'apple.com',
  'microsoft.com',
  'steam.com', 'steampowered.com', 'steamcommunity.com',
  'netflix.com',
  'pinterest.com', 'pin.it',
  'tumblr.com',
  'vimeo.com',
  'soundcloud.com',
  'bandcamp.com',
  'archive.org',
  'dropbox.com',
  'drive.google.com',
  'docs.google.com',
  'maps.google.com',
  'youtu.be', 'youtube.com',
  'open.spotify.com', 'spotify.com',
  'reddit.com', 'redd.it',
  'itch.io',
  'patreon.com',
  'ko-fi.com',
  'gofundme.com',
  'paypal.com',
  'stripe.com',
  'npm.io', 'npmjs.com',
  'pypi.org',
  'crates.io',
  'hub.docker.com',
  'vercel.app', 'netlify.app', 'pages.dev',
]);

function isNonApDomain(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (NON_AP_DOMAINS.has(lower)) return true;
  for (const domain of NON_AP_DOMAINS) {
    if (lower.endsWith('.' + domain)) return true;
  }
  return false;
}

function isActivityPubObject(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const ctx = obj['@context'];
  if (typeof ctx === 'string') return ctx.includes('activitystreams');
  if (Array.isArray(ctx)) return ctx.some((c: any) => typeof c === 'string' && c.includes('activitystreams'));
  return false;
}

class LinkPreviewService {
  private cache = new NodeCache({ stdTTL: 60 * 60 });
  private supabase = getSupabaseClient();
  private instanceDomain = config.INSTANCE_DOMAIN.toLowerCase();
  private apFailedDomains = new Map<string, number>();
  private static readonly AP_DOMAIN_FAIL_TTL = 5 * 60 * 1000; // skip domain for 5 min after failure

  private static readonly harmonyPostFields = `
        id,
        content,
        content_warning,
        visibility,
        is_deleted,
        is_local,
        media_attachments,
        author:profiles!posts_author_id_fkey(
          id,
          username,
          display_name,
          domain,
          avatar_url,
          color
        )
      `;

  async getPreview(url: string): Promise<EmbedPayload> {
    const normalizedUrl = this.normalizeUrl(url);

    // SSRF protection: reject private/internal URLs
    validateExternalUrl(normalizedUrl, { allowPlainHttp: true });

    const provider = this.detectProvider(normalizedUrl);
    const cacheKey = `${provider}:${normalizedUrl}`;

    const cached = this.cache.get<EmbedPayload>(cacheKey);
    if (cached && !this.isExpired(cached)) {
      return cached;
    }

    let payload: EmbedPayload;
    if (provider === 'harmony-post') {
      payload = await this.buildHarmonyEmbed(normalizedUrl);
    } else if (provider === 'youtube') {
      payload = await this.fetchOEmbed(normalizedUrl, 'https://www.youtube.com/oembed');
    } else if (provider === 'spotify') {
      // Short links (spotify.link) are not oEmbed URLs; the page they lead to names the item.
      payload = await this.fetchOEmbed(normalizedUrl, 'https://open.spotify.com/oembed')
        .catch(() => this.fetchGenericPreview(normalizedUrl));
    } else if (provider === 'soundcloud') {
      payload = await this.fetchOEmbed(normalizedUrl, 'https://soundcloud.com/oembed')
        .catch(() => this.fetchGenericPreview(normalizedUrl));
    } else if (provider === 'reddit') {
      payload = await this.fetchRedditPreview(normalizedUrl);
    } else if (provider === 'x' || provider === 'instagram' || provider === 'bluesky') {
      payload = await this.fetchPostPreview(normalizedUrl) ?? await this.fetchGenericPreview(normalizedUrl);
    } else {
      const klipyPayload = await this.fetchKlipyPreview(normalizedUrl);
      const wikipediaPayload = klipyPayload ? null : await this.fetchWikipediaPreview(normalizedUrl);
      payload = klipyPayload ?? wikipediaPayload ?? await this.fetchGenericPreview(normalizedUrl);
    }

    payload.cacheKey = cacheKey;
    payload.url = url;
    payload.normalizedUrl = normalizedUrl;
    // Preserve provider if fetchGenericPreview upgraded it (e.g., to 'fediverse-post')
    if (!payload.provider || payload.provider === 'generic') {
      payload.provider = provider;
    }
    // GIF pages: the image is the content; clients render bare media instead
    // of a link card, matching Discord.
    if (!payload.mediaOnly && payload.image && payload.provider === 'generic') {
      try {
        const host = new URL(normalizedUrl).hostname.toLowerCase().replace(/^www\./, '');
        if (GIF_PAGE_HOSTS.has(host) || (!WIKIMEDIA_HOST.test(host) && /\.gif(\?|#|$)/i.test(payload.image))) {
          payload.mediaOnly = true;
        }
      } catch { /* keep card rendering */ }
    }

    const effectiveProvider = payload.provider;
    const ttl = payload.failed ? FAILED_PREVIEW_TTL_MS : TTL_BY_PROVIDER[effectiveProvider];
    payload.fetchedAt = new Date().toISOString();
    payload.expiresAt = new Date(Date.now() + ttl).toISOString();

    this.cache.set(cacheKey, payload, ttl / 1000);
    return payload;
  }

  private isExpired(payload: EmbedPayload): boolean {
    return Date.now() >= new Date(payload.expiresAt).getTime();
  }

  private normalizeUrl(raw: string): string {
    let value = raw.trim();
    if (!/^https?:\/\//i.test(value)) {
      value = `https://${value}`;
    }
    try {
      const urlObj = new URL(value);
      urlObj.protocol = urlObj.protocol.toLowerCase();
      urlObj.hostname = urlObj.hostname.toLowerCase();
      if ((urlObj.protocol === 'https:' && urlObj.port === '443') ||
          (urlObj.protocol === 'http:' && urlObj.port === '80')) {
        urlObj.port = '';
      }
      return urlObj.toString();
    } catch {
      throw new Error('Invalid URL');
    }
  }

  private detectProvider(url: string): EmbedProvider {
    const urlObj = new URL(url);
    const host = urlObj.hostname.toLowerCase();
    if (host === this.instanceDomain && /^\/(?:posts|@[A-Za-z0-9_]+)\/[0-9a-fA-F-]{36}/.test(urlObj.pathname)) {
      return 'harmony-post';
    }
    if (host.includes('youtube.com') || host === 'youtu.be') {
      return 'youtube';
    }
    if (host.endsWith('spotify.com') || host === 'spotify.link' || host === 'spotify.app.link') {
      return 'spotify';
    }
    if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) {
      return 'soundcloud';
    }
    if (host === 'music.apple.com' || host === 'embed.music.apple.com') {
      return 'apple-music';
    }
    if (host === 'bandcamp.com' || host.endsWith('.bandcamp.com')) {
      return 'bandcamp';
    }
    if (host === 'deezer.com' || host.endsWith('.deezer.com') || host === 'deezer.page.link' || host === 'link.deezer.com') {
      return 'deezer';
    }
    if (host === 'tidal.com' || host.endsWith('.tidal.com')) {
      return 'tidal';
    }
    if (host.endsWith('reddit.com')) {
      return 'reddit';
    }
    const platform = socialPlatformOf(url);
    if (platform) return platform;
    // Everything else goes through generic, which auto-discovers AP via
    // <link rel="alternate" type="application/activity+json"> in the HTML.
    return 'generic';
  }

  /**
   * klipy.com/<collection>/<slug> pages → direct animated media via the
   * Klipy API. Returns null for non-klipy URLs or lookup failures so the
   * caller can fall through to the generic scraper.
   */
  private async fetchKlipyPreview(url: string): Promise<EmbedPayload | null> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }

    const host = parsed.hostname.toLowerCase();
    if (host !== 'klipy.com' && host !== 'www.klipy.com') return null;

    const m = parsed.pathname.match(/^\/(gifs|stickers|clips|static-memes|ai-gifs)\/([a-z0-9-]+)\/?$/i);
    if (!m) return null;

    const media = await fetchKlipyMediaBySlug(m[1].toLowerCase(), m[2]);
    if (!media) return null;

    return {
      cacheKey: '',
      url,
      normalizedUrl: url,
      provider: 'generic',
      title: media.title,
      siteName: 'Klipy',
      image: media.mediaUrl,
      mediaOnly: true,
      width: media.width,
      height: media.height,
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TTL_BY_PROVIDER.generic).toISOString(),
    };
  }

  /**
   * A post on X, Instagram or Bluesky with all its media (services/socialEmbeds.ts). Null when
   * the platform has nothing for the link; the page is then read as any other.
   */
  private async fetchPostPreview(url: string): Promise<EmbedPayload | null> {
    let post;
    try {
      post = await fetchSocialPreview(url);
    } catch (err) {
      logger.debug(`Post preview failed for ${url}: ${(err as Error).message}`);
      return null;
    }
    if (!post) return null;
    const { canonicalUrl, ...fields } = post;
    return {
      cacheKey: '',
      url,
      normalizedUrl: url,
      provider: post.social.platform,
      ...fields,
      ...(canonicalUrl && canonicalUrl !== url ? { canonicalUrl } : {}),
      fetchedAt: '',
      expiresAt: '',
    };
  }

  /**
   * <lang>.wikipedia.org/wiki/<title> → the REST page summary: title, lead extract and
   * thumbnail. Article pages carry no og:description. Returns null for other URLs
   * or failures (falls through to generic).
   */
  private async fetchWikipediaPreview(url: string): Promise<EmbedPayload | null> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }

    const lang = parsed.hostname.toLowerCase().match(/^([a-z0-9-]+)\.(?:m\.)?wikipedia\.org$/)?.[1];
    const title = parsed.pathname.match(/^\/wiki\/([^/]+)$/)?.[1];
    if (!lang || lang === 'www' || !title) return null;

    try {
      const res = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'HarmonyFederation/1.0 (link preview)' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      if (typeof data?.title !== 'string' || !data.title) return null;

      const extract = typeof data.extract === 'string' ? data.extract.trim() : '';
      const lead = extract.length > 300 ? `${extract.slice(0, 299).trimEnd()}…` : extract;
      const thumbnail = data.thumbnail?.source ? data.thumbnail : null;
      return {
        cacheKey: '',
        url,
        normalizedUrl: url,
        provider: 'generic',
        title: data.title,
        description: lead || (typeof data.description === 'string' ? data.description : undefined),
        siteName: 'Wikipedia',
        image: thumbnail?.source,
        width: thumbnail?.width,
        height: thumbnail?.height,
        icon: `https://${lang}.wikipedia.org/static/favicon/wikipedia.ico`,
        fetchedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + TTL_BY_PROVIDER.generic).toISOString(),
      };
    } catch (err) {
      logger.debug(`Wikipedia summary lookup failed for ${url}:`, err);
      return null;
    }
  }

  private async buildHarmonyEmbed(url: string): Promise<EmbedPayload> {
    // /posts/<id>, the Note's id, or /@<name>/<id>, its public page.
    const pathMatch = new URL(url).pathname.match(/^\/(?:posts|@[A-Za-z0-9_]+)\/([0-9a-fA-F-]{36})/);
    if (!pathMatch) {
      throw new Error('Invalid Harmony post URL');
    }
    const postId = pathMatch[1];
    type SupabasePost = {
      id: string;
      content: any;
      content_warning?: string | null;
      visibility: string;
      is_deleted: boolean;
      is_local: boolean;
      media_attachments: any;
      author?: {
        id?: string;
        username?: string;
        display_name?: string;
        domain?: string;
        avatar_url?: string | null;
        color?: string | null;
      } | null;
    };

    const { data, error } = await this.supabase
      .from('posts')
      .select(LinkPreviewService.harmonyPostFields)
      .eq('id', postId)
      .single() as { data: SupabasePost | null; error: any };

    if (error || !data) {
      logger.warn('Harmony post not found for embed', { postId, error });
      throw new Error('Harmony post not found');
    }

    if (data.is_deleted || !['public', 'unlisted'].includes(data.visibility)) {
      throw new Error('Post unavailable for embedding');
    }

    const summary = this.extractTextSummary(data.content) || 'View post on Harmony';
    const mediaAttachments = Array.isArray(data.media_attachments) ? data.media_attachments : [];
    // Posts written in the app say 'Image', ingested ones 'image'.
    const firstImage = mediaAttachments.find((attachment: any) => String(attachment?.type ?? '').toLowerCase() === 'image');

    return {
      cacheKey: '',
      url,
      normalizedUrl: url,
      provider: 'harmony-post',
      title: data.author?.display_name || data.author?.username || 'Harmony Post',
      description: summary,
      siteName: config.INSTANCE_DOMAIN,
      image: firstImage?.preview_url || firstImage?.url,
      icon: data.author?.avatar_url || undefined,
      color: data.author?.color || undefined,
      fetchedAt: '',
      expiresAt: '',
      harmony: {
        postId: data.id,
        instanceDomain: config.INSTANCE_DOMAIN,
        visibility: data.visibility,
        isLocal: data.is_local,
        author: {
          id: data.author?.id,
          username: data.author?.username,
          display_name: data.author?.display_name,
          domain: data.author?.domain,
          avatar_url: data.author?.avatar_url,
          color: data.author?.color,
        },
      },
    };
  }

  /**
   * Try to identify the fediverse platform from the AP Note's generator field,
   * or by fetching the instance's NodeInfo. Falls back to 'fediverse'.
   */
  private async detectPlatform(note: any, url: string): Promise<string> {
    // Mastodon sets a generator on the Note.
    if (note.generator?.name) {
      return note.generator.name.toLowerCase();
    }

    // Try NodeInfo discovery (cached per domain for 24h)
    const domain = new URL(url).hostname;
    const cacheKey = `nodeinfo:${domain}`;
    const cached = this.cache.get<string>(cacheKey);
    if (cached) return cached;

    try {
      const wellKnown = await this.fetchActivityPubObject(
        `https://${domain}/.well-known/nodeinfo`, true
      ).catch(() => null);

      if (wellKnown?.links?.length) {
        const link = wellKnown.links.find((l: any) =>
          l.rel?.includes('nodeinfo')
        );
        if (link?.href) {
          const nodeInfo = await this.fetchActivityPubObject(link.href, true).catch(() => null);
          if (nodeInfo?.software?.name) {
            const name = nodeInfo.software.name.toLowerCase();
            this.cache.set(cacheKey, name, 86400);
            return name;
          }
        }
      }
    } catch {
      // NodeInfo lookup is best-effort
    }

    this.cache.set(cacheKey, 'fediverse', 86400);
    return 'fediverse';
  }

  private async buildFediverseEmbed(url: string, prefetchedNote?: any, bypassCircuitBreaker = false): Promise<EmbedPayload> {
    try {
      const note = prefetchedNote ?? await this.fetchActivityPubObject(url, false, bypassCircuitBreaker);
      if (!note || (note.type !== 'Note' && note.type !== 'Article' && note.type !== 'Question')) {
        return this.buildMinimalGenericPayload(url, 'Not a recognized AP Note type');
      }

      const actorUrl = typeof note.attributedTo === 'string'
        ? note.attributedTo
        : note.attributedTo?.id || note.attributedTo;

      let authorName = 'Unknown';
      let authorHandle = '';
      let authorAvatar: string | undefined;
      let authorUrl = actorUrl || url;

      if (actorUrl && typeof actorUrl === 'string') {
        try {
          const actor = await this.fetchActivityPubObject(actorUrl, false, bypassCircuitBreaker);
          if (actor) {
            authorName = actor.name || actor.preferredUsername || 'Unknown';
            const actorDomain = new URL(actorUrl).hostname;
            authorHandle = `@${actor.preferredUsername || 'user'}@${actorDomain}`;
            authorAvatar = actor.icon?.url || actor.icon;
            if (typeof authorAvatar === 'object') authorAvatar = (authorAvatar as any)?.url;
            authorUrl = actor.url || actorUrl;
          }
        } catch (err) {
          logger.debug('Failed to fetch actor for fediverse embed', { actorUrl, err });
          const domain = new URL(url).hostname;
          authorHandle = `@unknown@${domain}`;
        }
      }

      const content = note.content || '';
      const plainText = decodeHtmlEntities(content.replace(/<[^>]*>/g, '').trim());
      const platform = await this.detectPlatform(note, url);

      const attachments = Array.isArray(note.attachment)
        ? note.attachment
          .filter((a: any) => a.type === 'Document' || a.type === 'Image' || a.type === 'Video')
          .map((a: any) => ({
            url: a.url,
            mediaType: a.mediaType,
            alt: a.name || undefined,
          }))
        : [];

      const firstImage = attachments.find((a: any) =>
        a.mediaType?.startsWith('image/') || /\.(jpe?g|png|gif|webp|avif)/i.test(a.url || '')
      );

      const stats = this.extractInteractionStats(note);

      return {
        cacheKey: '',
        url,
        normalizedUrl: url,
        provider: 'fediverse-post',
        title: authorName,
        description: plainText.substring(0, 280),
        siteName: new URL(url).hostname,
        image: firstImage?.url,
        icon: authorAvatar,
        fetchedAt: '',
        expiresAt: '',
        fediverse: {
          authorName,
          authorHandle,
          authorAvatar,
          authorUrl: typeof authorUrl === 'string' ? authorUrl : url,
          content,
          published: note.published || '',
          attachments,
          sensitive: note.sensitive || false,
          contentWarning: note.summary || undefined,
          platform,
          postUrl: note.url || url,
          stats,
        },
      };
    } catch (err) {
      logger.warn('Fediverse AP fetch failed, falling back to generic', { url, err });
      return this.buildMinimalGenericPayload(url, (err as Error).message);
    }
  }

  /**
   * Extract replies/reblogs/favourites counts from AP Note collections.
   * Mastodon uses replies/shares/likes collections with totalItems.
   * Misskey may use different fields or omit them entirely.
   */
  private extractInteractionStats(note: any): FediverseEmbedData['stats'] {
    const stats: NonNullable<FediverseEmbedData['stats']> = {};

    const extractCount = (field: any): number | undefined => {
      if (typeof field === 'number') return field;
      if (field?.totalItems !== undefined) return field.totalItems;
      if (field?.orderedItems) return Array.isArray(field.orderedItems) ? field.orderedItems.length : undefined;
      if (field?.items) return Array.isArray(field.items) ? field.items.length : undefined;
      return undefined;
    };

    stats.replies = extractCount(note.replies) ?? extractCount(note.repliesCount);
    stats.reblogs = extractCount(note.shares) ?? extractCount(note.renoteCount);
    stats.favourites = extractCount(note.likes) ?? extractCount(note.favouritesCount)
      ?? extractCount(note.reactionCount);

    if (stats.replies === undefined && stats.reblogs === undefined && stats.favourites === undefined) {
      return undefined;
    }
    return stats;
  }

  private async fetchActivityPubObject(url: string, acceptJson = false, bypassCircuitBreaker = false): Promise<any> {
    const domain = new URL(url).hostname;
    if (!bypassCircuitBreaker) {
      const failedAt = this.apFailedDomains.get(domain);
      if (failedAt && Date.now() - failedAt < LinkPreviewService.AP_DOMAIN_FAIL_TTL) {
        throw new Error(`AP domain ${domain} recently failed, skipping`);
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const accept = acceptJson
        ? 'application/json'
        : 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams", application/json';
      // Signed as the instance actor; instances in authorized fetch mode
      // refuse unsigned GETs.
      const response = await SignatureService.signedApFetch(url, {
        headers: {
          Accept: accept,
          'User-Agent': USER_AGENT,
        },
        signal: controller.signal,
        // safeFetch always follows redirects manually with per-hop
        // re-validation (max 3 by default) - supersedes `redirect: 'follow'`.
      });

      if (!response.ok) {
        this.apFailedDomains.set(domain, Date.now());
        throw new Error(`AP fetch failed (${response.status})`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('json')) {
        throw new Error(`Not an AP response (${contentType})`);
      }

      // Success clears the domain's failure record.
      this.apFailedDomains.delete(domain);
      return await response.json();
    } catch (err) {
      this.apFailedDomains.set(domain, Date.now());
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchOEmbed(url: string, endpoint: string): Promise<EmbedPayload> {
    const endpointUrl = new URL(endpoint);
    endpointUrl.searchParams.set('url', url);
    endpointUrl.searchParams.set('format', 'json');

    const response = await safeFetch(endpointUrl.toString(), {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`oEmbed request failed (${response.status})`);
    }

    const data = await response.json();
    const frameSrc = typeof data.html === 'string' ? /<iframe[^>]+src=["']([^"']+)["']/i.exec(data.html)?.[1] : undefined;
    const player = providerPlayerUrl(frameSrc ? decodeHtmlEntities(frameSrc) : undefined);
    return {
      cacheKey: '',
      url,
      normalizedUrl: url,
      provider: 'generic',
      title: decodeHtmlEntities(data.title || data.author_name || url),
      description: decodeHtmlEntities(data.author_name || data.provider_name || ''),
      siteName: data.provider_name || new URL(url).hostname,
      image: data.thumbnail_url,
      html: data.html,
      width: data.width,
      height: data.height,
      ...(player ? { player: { url: player, ...(Number(data.height) > 0 ? { height: Number(data.height) } : {}) } } : {}),
      fetchedAt: '',
      expiresAt: '',
    };
  }

  private async fetchRedditPreview(url: string): Promise<EmbedPayload> {
    const endpoint = new URL('https://www.reddit.com/oembed');
    endpoint.searchParams.set('url', url);
    endpoint.searchParams.set('format', 'json');

    const response = await safeFetch(endpoint.toString(), {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Reddit oEmbed failed (${response.status})`);
    }

    const data = await response.json();
    return {
      cacheKey: '',
      url,
      normalizedUrl: url,
      provider: 'reddit',
      title: decodeHtmlEntities(data.title || url),
      description: data.author_name ? `Posted by ${decodeHtmlEntities(data.author_name)}` : undefined,
      siteName: 'Reddit',
      image: data.thumbnail_url,
      html: data.html,
      width: data.width,
      height: data.height,
      fetchedAt: '',
      expiresAt: '',
    };
  }

  private async fetchGenericPreview(url: string): Promise<EmbedPayload> {
    const hostname = new URL(url).hostname;

    // Step 1: Try AP content negotiation first (unless domain is known non-AP)
    if (!isNonApDomain(hostname)) {
      try {
        const apObj = await this.fetchActivityPubObject(url);
        if (isActivityPubObject(apObj)) {
          if (apObj.type === 'Note' || apObj.type === 'Article' || apObj.type === 'Question') {
            logger.info(`AP-first detection succeeded for ${url} (type: ${apObj.type})`);
            return this.buildFediverseEmbed(url, apObj);
          }
        }
      } catch {
        // AP fetch failed - expected for non-fediverse URLs, continue to HTML
      }
    }

    // Step 2: Fetch HTML and look for AP alternate link or extract OG metadata
    try {
      // Slow pages (a game server under load answered q3.pieter.com in over 10 s) get 15 s;
      // the fetch runs in the background of a sent message.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HTML_FETCH_TIMEOUT_MS);
      let response: Response;
      let html = '';
      let landedAt = url;
      try {
        response = await safeFetch(url, {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml',
          },
          signal: controller.signal,
          // HTML link-preview chains run 4-5 hops (t.co → publisher → www →
          // canonical → cookie consent). The default of 3 suffices for AP
          // content but truncates these, so this call allows 5.
          maxRedirects: 5,
          maxBodyBytes: Infinity,
          allowPlainHttp: true,
          timeoutMs: HTML_FETCH_TIMEOUT_MS,
        });

        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new Error(`Request failed (${response.status})`);
        }

        // The link answered with the media itself (embed fixers redirect previewers to it).
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        const finalUrl = response.url || url;
        landedAt = finalUrl;
        if (contentType.startsWith('image/') || contentType.startsWith('video/')) {
          await response.body?.cancel().catch(() => {});
          const media = contentType.startsWith('video/')
            ? { video: { url: finalUrl, type: contentType.split(';')[0] } }
            : { image: finalUrl };
          return {
            cacheKey: '',
            url,
            normalizedUrl: url,
            provider: 'generic',
            title: hostname,
            siteName: hostname,
            mediaOnly: true,
            ...media,
            fetchedAt: '',
            expiresAt: '',
          };
        }

        html = await readHead(response);
      } finally {
        clearTimeout(timeout);
      }

      // An ActivityPub alternate link upgrades to a fediverse embed. Covers
      // the case where the AP endpoint URL differs from the HTML page URL.
      const apAlternate = this.findApAlternateLink(html);
      if (apAlternate) {
        logger.info(`Found AP alternate link for ${url}: ${apAlternate}`);
        try {
          const apUrl = this.makeAbsoluteUrl(url, apAlternate);
          const result = await this.buildFediverseEmbed(apUrl, undefined, true);
          if (result.provider === 'fediverse-post') {
            result.url = url;
            result.normalizedUrl = url;
            if (result.fediverse && !result.fediverse.stats) {
              result.fediverse.stats = this.extractStatsFromHtml(html);
            }
            return result;
          }
        } catch (err) {
          logger.warn(`AP alternate link found but fetch failed for ${url}:`, err);
        }
      }

      const meta = parseMetaTags(html);
      const first = (...keys: string[]) => keys.map(k => meta.get(k)).find(Boolean);

      const title = first('og:title', 'twitter:title')
        ?? this.extractMeta(html, [/<title[^>]*>([^<]+)<\/title>/i]);
      const description = first('og:description', 'twitter:description', 'description');
      const image = first('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src');
      const siteName = first('og:site_name', 'application-name');
      const icon = parseIconHref(html);

      const videoUrl = first('og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream');
      const videoType = first('og:video:type', 'twitter:player:stream:content_type');
      // An HTML player page (YouTube's og:video) is not a file a <video> element plays.
      const playable = videoUrl && (
        (videoType ?? '').toLowerCase().startsWith('video/') || /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(videoUrl)
      );
      const dimension = (key: string) => {
        const n = Number(meta.get(key));
        return Number.isFinite(n) && n > 0 ? n : undefined;
      };
      const ogUrl = first('og:url');
      const canonical = ogUrl ? this.makeAbsoluteUrl(url, ogUrl) : (landedAt !== url ? landedAt : undefined);
      const playerPage = providerPlayerUrl(first('twitter:player') ?? (playable ? undefined : videoUrl));

      return {
        cacheKey: '',
        url,
        normalizedUrl: url,
        provider: 'generic',
        ...(canonical && canonical !== url ? { canonicalUrl: canonical } : {}),
        ...(playerPage ? { player: { url: playerPage, height: dimension('twitter:player:height') } } : {}),
        title: title || url,
        description: description || undefined,
        siteName: siteName || hostname,
        image: image ? this.makeAbsoluteUrl(url, image) : undefined,
        icon: icon ? this.makeAbsoluteUrl(url, icon) : undefined,
        ...(playable ? {
          video: {
            url: this.makeAbsoluteUrl(url, videoUrl!),
            type: videoType,
            width: dimension('og:video:width') ?? dimension('twitter:player:width'),
            height: dimension('og:video:height') ?? dimension('twitter:player:height'),
          },
        } : {}),
        fetchedAt: '',
        expiresAt: '',
      };
    } catch (error) {
      // The reason stays in the log; a reader sees no card rather than an error message.
      logger.warn('Failed to fetch generic preview', { url, error: (error as Error).message });
      return {
        cacheKey: '',
        url,
        normalizedUrl: url,
        provider: 'generic',
        title: url,
        siteName: hostname,
        failed: true,
        fetchedAt: '',
        expiresAt: '',
      };
    }
  }

  /**
   * Build a minimal generic payload without calling fetchGenericPreview.
   * Avoids circular calls between buildFediverseEmbed ↔ fetchGenericPreview.
   */
  private buildMinimalGenericPayload(url: string, reason?: string): EmbedPayload {
    let hostname = url;
    try { hostname = new URL(url).hostname; } catch { logger.debug(`Invalid URL for hostname extraction: ${url}`); }
    return {
      cacheKey: '',
      url,
      normalizedUrl: url,
      provider: 'generic',
      title: hostname,
      description: reason || '',
      siteName: hostname,
      fetchedAt: '',
      expiresAt: '',
    };
  }

  /**
   * Extract interaction stats from platform-specific JSON embedded in the HTML.
   * Misskey embeds full note data in `<script id="misskey_clientCtx">`.
   */
  private extractStatsFromHtml(html: string): FediverseEmbedData['stats'] | undefined {
    // Misskey / Sharkey / Firefish - embedded client context
    const misskeyMatch = html.match(
      /<script[^>]+id=["']misskey_clientCtx["'][^>]*>([\s\S]*?)<\/script>/i
    );
    if (misskeyMatch?.[1]) {
      try {
        const ctx = JSON.parse(misskeyMatch[1]);
        const note = ctx.note;
        if (note) {
          return {
            replies: note.repliesCount ?? undefined,
            reblogs: note.renoteCount ?? undefined,
            favourites: note.reactionCount ?? undefined,
          };
        }
      } catch { /* malformed JSON, ignore */ }
    }
    return undefined;
  }

  /**
   * Find `<link rel="alternate" type="application/activity+json" href="...">` regardless
   * of attribute ordering. Handles Mastodon, Misskey, Pleroma, GoToSocial, etc.
   */
  private findApAlternateLink(html: string): string | undefined {
    const linkTags = html.match(/<link[^>]*>/gi);
    if (!linkTags) return undefined;

    for (const tag of linkTags) {
      const isAlternate = /rel=["']alternate["']/i.test(tag);
      const isActivityJson = /type=["']application\/activity\+json["']/i.test(tag);
      if (isAlternate && isActivityJson) {
        const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
        if (hrefMatch?.[1]) return hrefMatch[1];
      }
    }
    return undefined;
  }

  private extractTextSummary(content: any): string {
    if (!Array.isArray(content)) return '';
    return content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ')
      .slice(0, 280);
  }

  private extractMeta(html: string, patterns: RegExp[]): string | undefined {
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        return decodeHtmlEntities(match[1]);
      }
    }
    return undefined;
  }

  private makeAbsoluteUrl(base: string, candidate: string): string {
    if (!candidate) return candidate;
    if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(candidate)) {
      return candidate;
    }
    if (candidate.startsWith('//')) {
      return `https:${candidate}`;
    }
    const origin = new URL(base).origin;
    if (candidate.startsWith('/')) {
      return `${origin}${candidate}`;
    }
    return `${origin}/${candidate}`;
  }
}

export const linkPreviewService = new LinkPreviewService();

// Named export for webhook route
export async function fetchLinkPreview(url: string): Promise<EmbedPayload> {
  return linkPreviewService.getPreview(url);
}

export default linkPreviewService;

