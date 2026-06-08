/**
 * Resolve the end-user's browser User-Agent for upstream APIs (e.g. Klipy ads).
 *
 * The GIF proxy sits behind nginx/vite, so we prefer an explicit header the
 * frontend sets from `navigator.userAgent`, then fall back to the request's
 * User-Agent (which proxies normally forward unchanged).
 */

type HeaderValue = string | string[] | undefined;

function firstString(value: HeaderValue): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim()) return entry.trim();
    }
  }
  return undefined;
}

export function resolveClientUserAgent(headers: Record<string, HeaderValue>): string | undefined {
  return (
    firstString(headers['x-client-user-agent']) ||
    firstString(headers['user-agent'])
  );
}
