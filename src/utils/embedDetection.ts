import type { EmbedProvider } from '@/types';

const primaryDomain = (import.meta.env.VITE_DOMAIN as string || window.location.hostname).toLowerCase();
const extraDomains = (import.meta.env.VITE_HARMONY_ALT_DOMAINS as string || '')
  .split(',')
  .map((domain) => domain.trim().toLowerCase())
  .filter(Boolean);

const harmonyDomains = new Set<string>([primaryDomain, ...extraDomains]);

export function normalizeEmbedUrl(raw: string): string | null {
  try {
    let value = raw.trim();
    if (!/^https?:\/\//i.test(value)) {
      value = `https://${value}`;
    }
    const url = new URL(value);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function parseEmbedUrl(raw: string): URL | null {
  const normalized = normalizeEmbedUrl(raw);
  if (!normalized) {
    return null;
  }
  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

export function detectEmbedProviderFromUrl(input: string | URL): EmbedProvider {
  const url = typeof input === 'string' ? parseEmbedUrl(input) : input;
  if (!url) {
    return 'generic';
  }
  if (isHarmonyInviteUrl(url)) {
    return 'harmony-invite';
  }
  if (isHarmonyPostUrl(url)) {
    return 'harmony-post';
  }
  if (isYouTubeUrl(url)) {
    return 'youtube';
  }
  if (isSpotifyUrl(url)) {
    return 'spotify';
  }
  return 'generic';
}

export function isHarmonyPostUrl(url: URL): boolean {
  return harmonyDomains.has(url.hostname.toLowerCase()) && /^\/(social\/)?posts\/[a-zA-Z0-9-]+/.test(url.pathname);
}

export function isHarmonyInviteUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  const isHarmonyDomain = harmonyDomains.has(hostname) || 
                          hostname === 'localhost';
  return isHarmonyDomain && /^\/invite\/[A-Za-z0-9]+$/.test(url.pathname);
}

export function getHarmonyInviteCode(url: URL): string | null {
  if (!isHarmonyInviteUrl(url)) {
    return null;
  }
  const match = url.pathname.match(/^\/invite\/([A-Za-z0-9]+)$/);
  return match ? match[1] : null;
}

export function getHarmonyPostId(url: URL): string | null {
  if (!isHarmonyPostUrl(url)) {
    return null;
  }
  const match = url.pathname.match(/^\/(social\/)?posts\/([a-zA-Z0-9-]+)/);
  return match ? match[2] : null;
}

export function isYouTubeUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
}

export function isSpotifyUrl(url: URL): boolean {
  return url.hostname.toLowerCase().endsWith('spotify.com');
}

export function extractYouTubeId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id || null;
  }

  if (host.includes('youtube.com')) {
    if (url.pathname === '/watch') {
      return url.searchParams.get('v');
    }

    if (url.pathname.startsWith('/shorts/')) {
      return url.pathname.split('/')[2];
    }

    if (url.pathname.startsWith('/embed/')) {
      return url.pathname.split('/')[2];
    }

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length >= 2 && segments[0] === 'live') {
      return segments[1];
    }
  }

  return null;
}

/**
 * Parse YouTube time parameter to seconds.
 * Handles: ?t=90, ?t=1m30s, ?t=1h2m30s, &t=90, youtu.be/id?t=90
 */
function parseYouTubeTime(url: URL): number | null {
  const t = url.searchParams.get('t') || url.searchParams.get('start');
  if (!t) return null;

  // Pure number = seconds
  if (/^\d+$/.test(t)) return parseInt(t, 10);

  let total = 0;
  const hours = t.match(/(\d+)h/);
  const minutes = t.match(/(\d+)m/);
  const seconds = t.match(/(\d+)s/);
  if (hours) total += parseInt(hours[1], 10) * 3600;
  if (minutes) total += parseInt(minutes[1], 10) * 60;
  if (seconds) total += parseInt(seconds[1], 10);
  return total > 0 ? total : null;
}

export function buildYouTubeEmbedUrl(url: URL): string | null {
  const videoId = extractYouTubeId(url);
  if (!videoId) return null;

  const startTime = parseYouTubeTime(url);
  const embedUrl = `https://www.youtube.com/embed/${videoId}`;
  return startTime ? `${embedUrl}?start=${startTime}` : embedUrl;
}

export function buildSpotifyEmbedUrl(url: URL): string | null {
  if (!isSpotifyUrl(url)) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const [resourceType, resourceId] = segments;
  if (!resourceType || !resourceId) return null;
  return `https://open.spotify.com/embed/${resourceType}/${resourceId}`;
}

