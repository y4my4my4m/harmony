import NodeCache from 'node-cache';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { SignatureService } from '../activitypub/SignatureService.js';
import { validateExternalUrl, safeFetch } from '../utils/ssrfProtection.js';
import { decodeHtmlEntities } from '../utils/contentUtils.js';

export type EmbedProvider = 'harmony-post' | 'fediverse-post' | 'youtube' | 'spotify' | 'reddit' | 'generic';

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
  generic: 24 * 60 * 60 * 1000, // 24 hours
};

const USER_AGENT = 'HarmonyLinkPreview/1.0 (+https://har.mony.lol)';

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
    validateExternalUrl(normalizedUrl);

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
      payload = await this.fetchOEmbed(normalizedUrl, 'https://open.spotify.com/oembed');
    } else if (provider === 'reddit') {
      payload = await this.fetchRedditPreview(normalizedUrl);
    } else {
      payload = await this.fetchGenericPreview(normalizedUrl);
    }

    payload.cacheKey = cacheKey;
    payload.url = url;
    payload.normalizedUrl = normalizedUrl;
    // Preserve provider if fetchGenericPreview upgraded it (e.g., to 'fediverse-post')
    if (!payload.provider || payload.provider === 'generic') {
      payload.provider = provider;
    }
    const effectiveProvider = payload.provider;
    payload.fetchedAt = new Date().toISOString();
    payload.expiresAt = new Date(Date.now() + TTL_BY_PROVIDER[effectiveProvider]).toISOString();

    this.cache.set(cacheKey, payload, TTL_BY_PROVIDER[effectiveProvider] / 1000);
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
    if (host === this.instanceDomain && /^\/posts\/[0-9a-fA-F-]{36}/.test(urlObj.pathname)) {
      return 'harmony-post';
    }
    if (host.includes('youtube.com') || host === 'youtu.be') {
      return 'youtube';
    }
    if (host.endsWith('spotify.com')) {
      return 'spotify';
    }
    if (host.endsWith('reddit.com')) {
      return 'reddit';
    }
    // Everything else goes through generic, which auto-discovers AP via
    // <link rel="alternate" type="application/activity+json"> in the HTML.
    return 'generic';
  }

  private async buildHarmonyEmbed(url: string): Promise<EmbedPayload> {
    const pathMatch = url.match(/\/posts\/([0-9a-fA-F-]{36})/);
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
    const firstImage = mediaAttachments.find((attachment: any) => attachment?.type === 'image');

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
    // Some platforms set a generator on the Note (Mastodon does this)
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
      let response = await safeFetch(url, {
        headers: {
          Accept: accept,
          'User-Agent': USER_AGENT,
        },
        signal: controller.signal,
        // safeFetch always follows redirects manually with per-hop
        // re-validation (max 3 by default) - supersedes `redirect: 'follow'`.
      });

      // Retry with HTTP signature for instances requiring authorized fetch
      if (response.status === 401 || response.status === 403) {
        clearTimeout(timeout);
        logger.info(`🔐 AP fetch got ${response.status}, retrying with HTTP signature: ${url}`);
        try {
          response = await SignatureService.signedApFetch(url);
          logger.info(`🔐 Signed AP fetch result: ${response.status} for ${url}`);
        } catch (signedErr) {
          logger.warn(`🔐 Signed AP fetch failed for ${url}:`, signedErr);
          throw new Error(`Signed AP fetch also failed for ${url}`);
        }
      }

      if (!response.ok) {
        this.apFailedDomains.set(domain, Date.now());
        throw new Error(`AP fetch failed (${response.status})`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('json')) {
        throw new Error(`Not an AP response (${contentType})`);
      }

      // Success - clear any failure record
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
            logger.info(`🔍 AP-first detection succeeded for ${url} (type: ${apObj.type})`);
            return this.buildFediverseEmbed(url, apObj);
          }
        }
      } catch {
        // AP fetch failed - expected for non-fediverse URLs, continue to HTML
      }
    }

    // Step 2: Fetch HTML and look for AP alternate link or extract OG metadata
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let response: Response;
      try {
        response = await safeFetch(url, {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml',
          },
          signal: controller.signal,
          // HTML link-preview path commonly traverses 4–5 hops (t.co →
          // publisher → www → canonical → cookie consent). The default
          // of 3 is sufficient for AP-content but cuts off legitimate
          // tracker chains here, so allow 5 specifically on this site.
          maxRedirects: 5,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }

      const html = await response.text();

      // Check for ActivityPub alternate link - upgrade to fediverse embed if found.
      // Still useful when the AP endpoint URL differs from the HTML page URL.
      const apAlternate = this.findApAlternateLink(html);
      if (apAlternate) {
        logger.info(`🔍 Found AP alternate link for ${url}: ${apAlternate}`);
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
          logger.warn(`🔍 AP alternate link found but fetch failed for ${url}:`, err);
        }
      }

      const title = this.extractMeta(html, [
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
        /<title[^>]*>([^<]+)<\/title>/i,
      ]);

      const description = this.extractMeta(html, [
        /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
      ]);

      const image = this.extractMeta(html, [
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      ]);

      const icon = this.extractMeta(html, [
        /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i,
      ]);

      return {
        cacheKey: '',
        url,
        normalizedUrl: url,
        provider: 'generic',
        title: title || url,
        description: description || undefined,
        siteName: hostname,
        image: image ? this.makeAbsoluteUrl(url, image) : undefined,
        icon: icon ? this.makeAbsoluteUrl(url, icon) : undefined,
        fetchedAt: '',
        expiresAt: '',
      };
    } catch (error) {
      logger.warn('Failed to fetch generic preview', { url, error });
      return {
        cacheKey: '',
        url,
        normalizedUrl: url,
        provider: 'generic',
        title: url,
        description: (error as Error).message,
        siteName: hostname,
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

