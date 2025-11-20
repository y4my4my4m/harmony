import NodeCache from 'node-cache';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

export type EmbedProvider = 'harmony-post' | 'youtube' | 'spotify' | 'generic';

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
}

const TTL_BY_PROVIDER: Record<EmbedProvider, number> = {
  'harmony-post': 5 * 60 * 1000, // 5 minutes
  youtube: 6 * 60 * 60 * 1000, // 6 hours
  spotify: 6 * 60 * 60 * 1000,
  generic: 24 * 60 * 60 * 1000, // 24 hours
};

const USER_AGENT = 'HarmonyLinkPreview/1.0 (+https://har.mony.lol)';

class LinkPreviewService {
  private cache = new NodeCache({ stdTTL: 60 * 60 });
  private supabase = getSupabaseClient();
  private instanceDomain = config.INSTANCE_DOMAIN.toLowerCase();

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
    } else {
      payload = await this.fetchGenericPreview(normalizedUrl);
    }

    payload.cacheKey = cacheKey;
    payload.url = url;
    payload.normalizedUrl = normalizedUrl;
    payload.provider = provider;
    payload.fetchedAt = new Date().toISOString();
    payload.expiresAt = new Date(Date.now() + TTL_BY_PROVIDER[provider]).toISOString();

    this.cache.set(cacheKey, payload, TTL_BY_PROVIDER[provider] / 1000);
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
      .from<SupabasePost>('posts')
      .select(LinkPreviewService.harmonyPostFields)
      .eq('id', postId)
      .single();

    if (error || !data) {
      logger.warn('Harmony post not found for embed', { postId, error });
      throw new Error('Harmony post not found');
    }

    if (data.is_deleted || !['public', 'unlisted'].includes(data.visibility)) {
      throw new Error('Post unavailable for embedding');
    }

    const summary = this.extractTextSummary(data.content) || 'View post on Harmony';
    const mediaAttachments = Array.isArray(data.media_attachments) ? data.media_attachments : [];
    const firstImage = mediaAttachments.find((attachment) => attachment?.type === 'image');

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

  private async fetchOEmbed(url: string, endpoint: string): Promise<EmbedPayload> {
    const endpointUrl = new URL(endpoint);
    endpointUrl.searchParams.set('url', url);
    endpointUrl.searchParams.set('format', 'json');

    const response = await fetch(endpointUrl.toString(), {
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
      title: data.title || data.author_name || url,
      description: data.author_name || data.provider_name,
      siteName: data.provider_name || new URL(url).hostname,
      image: data.thumbnail_url,
      html: data.html,
      width: data.width,
      height: data.height,
      fetchedAt: '',
      expiresAt: '',
    };
  }

  private async fetchGenericPreview(url: string): Promise<EmbedPayload> {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
        },
      });

      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }

      const html = await response.text();
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
        siteName: new URL(url).hostname,
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
        siteName: new URL(url).hostname,
        fetchedAt: '',
        expiresAt: '',
      };
    }
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
        return match[1];
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

