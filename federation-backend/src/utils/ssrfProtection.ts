/**
 * SSRF Protection
 *
 * Validates URLs before making outbound HTTP requests to prevent
 * Server-Side Request Forgery against internal networks, cloud
 * metadata endpoints, and other sensitive destinations.
 */

import { logger } from './logger.js';
import dns from 'dns';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.google',
]);

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return false;

  const [a, b] = parts;

  // 127.0.0.0/8  loopback
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16  link-local / cloud metadata
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 100.64.0.0/10  carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 198.18.0.0/15  benchmarking
  if (a === 198 && (b === 18 || b === 19)) return true;

  return false;
}

/**
 * Validate a URL is safe to fetch (not pointing at internal services).
 * Returns the validated URL or throws with a descriptive error.
 */
export function validateExternalUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Blocked protocol: ${url.protocol}`);
  }

  // `new URL('http://[::1]').hostname` returns `'[::1]'` (with brackets) on
  // modern Node (WHATWG URL spec) — strip them before pattern checks.
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Blocked hostname: ${hostname}`);
  }

  // Block raw IP addresses that are private
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    if (isBlockedIPv4(hostname)) {
      throw new Error(`Blocked private IP: ${hostname}`);
    }
  }

  // Block IPv6 loopback / private. Only match actual IPv6 literals (contain
  // ':'), not regular hostnames that happen to start with 'fc'/'fd'.
  if (hostname.includes(':')) {
    if (isBlockedIPv6(hostname)) {
      throw new Error(`Blocked private IPv6: ${hostname}`);
    }
  }

  return url;
}

/**
 * Validate a hostname (not a full URL) is safe to connect to.
 * Use this for cases like `fetch(\`https://${instance}/...\`)`.
 */
export function validateExternalHostname(hostname: string): void {
  // Strip any surrounding `[...]` IPv6 brackets so the same checks below
  // work whether the caller passed `[::1]` or `::1`.
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (BLOCKED_HOSTNAMES.has(lower)) {
    throw new Error(`Blocked hostname: ${lower}`);
  }

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) {
    if (isBlockedIPv4(lower)) {
      throw new Error(`Blocked private IP: ${lower}`);
    }
  }

  if (lower.includes(':')) {
    if (isBlockedIPv6(lower)) {
      throw new Error(`Blocked private IPv6: ${lower}`);
    }
  }
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ::1 loopback
  if (lower === '::1' || lower === '::') return true;
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) — check the embedded v4
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (mapped && isBlockedIPv4(mapped[1])) return true;
  // fc00::/7  Unique Local Addresses
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // fe80::/10  link-local
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  return false;
}

/**
 * Resolve hostname via DNS (both A and AAAA records) and verify NONE of
 * the resolved IPs are in private / link-local / loopback ranges.
 *
 * This defends against:
 *  - hostnames that resolve to private IPs (e.g. `metadata.example.com` →
 *    169.254.169.254),
 *  - DNS rebinding attacks where the first resolution is public and
 *    subsequent resolutions are private (mitigated when we re-resolve
 *    on every redirect in `safeFetch`).
 *
 * DNS failures (NXDOMAIN, refused) are treated as benign — they aren't a
 * security concern here, and surface naturally when the actual fetch
 * also fails to resolve.
 */
export async function validateResolvedAddress(hostname: string): Promise<void> {
  // Use `dns.promises` (looked up at call time, not module load time) so
  // tests can `vi.spyOn(dns.promises, 'resolve4')` and intercept.
  const [v4, v6] = await Promise.allSettled([
    dns.promises.resolve4(hostname),
    dns.promises.resolve6(hostname),
  ]);

  if (v4.status === 'fulfilled') {
    for (const ip of v4.value) {
      if (isBlockedIPv4(ip)) {
        logger.warn(`🚫 SSRF: ${hostname} resolves to private IPv4 ${ip}`);
        throw new Error(`Hostname ${hostname} resolves to blocked private IP`);
      }
    }
  }
  if (v6.status === 'fulfilled') {
    for (const ip of v6.value) {
      if (isBlockedIPv6(ip)) {
        logger.warn(`🚫 SSRF: ${hostname} resolves to private IPv6 ${ip}`);
        throw new Error(`Hostname ${hostname} resolves to blocked private IP`);
      }
    }
  }
  // If BOTH lookups failed, the upstream fetch will fail naturally.
}

// ============================================================================
// safeFetch — the canonical helper for outbound HTTP from federation code.
// ============================================================================

export interface SafeFetchOptions extends Omit<RequestInit, 'redirect' | 'signal'> {
  /**
   * Max redirects to follow. Each hop is re-validated through
   * `validateExternalUrl` + `validateResolvedAddress`. Default: 3.
   */
  maxRedirects?: number;
  /**
   * Per-attempt timeout in ms. Each redirect hop gets a fresh timer.
   * Default: 10_000.
   */
  timeoutMs?: number;
  /**
   * Optional external AbortSignal to merge with the internal timeout.
   * Cancellation from EITHER source aborts the fetch.
   */
  signal?: AbortSignal;
}

function linkSignals(external: AbortSignal | undefined, internal: AbortController): AbortSignal {
  if (!external) return internal.signal;
  if (external.aborted) {
    internal.abort(external.reason);
    return internal.signal;
  }
  external.addEventListener('abort', () => internal.abort(external.reason), { once: true });
  return internal.signal;
}

/**
 * SSRF-safe wrapper around `fetch()`. Use this for EVERY outbound HTTP
 * request made from federation-backend code that operates on
 * attacker-influenced URLs (inbox activities, /resolve-post, /fetch-posts,
 * NodeInfo probes, reply-chain resolution, actor refresh, backfill scripts).
 *
 * Guarantees, on every hop (initial request + every redirect):
 *   1. URL scheme is `http:` or `https:` (file:, gopher:, dict:, etc. blocked).
 *   2. Hostname is not in the static blocked list (localhost, cloud
 *      metadata aliases).
 *   3. If the hostname is a literal IP, it is not in any private /
 *      link-local / loopback range.
 *   4. DNS A and AAAA resolutions of the hostname are not in any private
 *      range (defends against DNS rebinding and CNAMEs to internal hosts).
 *   5. Redirects are followed MANUALLY with a re-validation per hop
 *      (cannot bypass via `301 → http://internal/`).
 *   6. Each attempt is bounded by `timeoutMs` (default 10s).
 *
 * What this DOES NOT guarantee:
 *   - Response body size (caller is responsible — most call sites use
 *     `await res.text()` which can OOM on huge payloads; cap via your own
 *     `Content-Length` check or stream with a counter).
 *   - DNS TOCTOU between this check and the kernel's connect() (mitigated
 *     in practice by node returning cached lookups within a request, but
 *     a fully paranoid setup would also pin the IP via `lookup` in
 *     `agent`. Out of scope here.).
 */
export async function safeFetch(urlString: string, options: SafeFetchOptions = {}): Promise<Response> {
  const {
    maxRedirects = 3,
    timeoutMs = 10_000,
    signal: externalSignal,
    ...fetchInit
  } = options;

  let currentUrl = urlString;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = validateExternalUrl(currentUrl);
    await validateResolvedAddress(url.hostname);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`safeFetch: timeout after ${timeoutMs}ms`)), timeoutMs);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        ...fetchInit,
        redirect: 'manual',
        signal: linkSignals(externalSignal, ac),
      });
    } finally {
      clearTimeout(timer);
    }

    // 3xx with a Location header → follow manually after re-validation.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      // Drain the redirect response body so node doesn't leak the socket.
      try { await response.body?.cancel(); } catch { /* noop */ }
      const nextUrl = new URL(location, currentUrl).href;
      logger.info(`🔁 safeFetch redirect ${hop + 1}/${maxRedirects}: ${url.href} → ${nextUrl}`);
      currentUrl = nextUrl;
      continue;
    }

    return response;
  }

  throw new Error(`safeFetch: too many redirects (max=${maxRedirects})`);
}

// Internal helper exported for tests only. Treat as `@internal`.
export const __test__ = { isBlockedIPv4, isBlockedIPv6 };
