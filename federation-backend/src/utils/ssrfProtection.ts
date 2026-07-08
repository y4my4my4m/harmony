/**
 * SSRF Protection
 *
 * Validates URLs before making outbound HTTP requests to prevent
 * Server-Side Request Forgery against internal networks, cloud
 * metadata endpoints, and other sensitive destinations.
 */

import { logger } from './logger.js';
import dns from 'dns';

// Keep-alive dispatcher for federation outbound HTTP. Node's default undici Agent
// has a 4s keep-alive — too short for fan-out delivery (same instance hit within
// seconds, TLS handshake dominates), so use 30s keep-alive + per-origin pool.
// Dynamic-import undici so the file still works without it (fall back to default agent).
let federationDispatcher: any | undefined;
try {
  // Top-level await is allowed in this ESM module.
  const { Agent } = await import('undici');
  federationDispatcher = new Agent({
    // Reuse the TCP+TLS connection for 30 s of idle time before closing.
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    // 50 concurrent connections per origin is generous; federation fan-out
    // is bursty but each remote instance rarely needs more than a handful.
    connections: 50,
    // Per-request socket-level timeouts (NOT the application timeout below).
    // These guard against half-open connections without affecting the
    // explicit `timeoutMs` budget enforced by `safeFetch`.
    bodyTimeout: 30_000,
    headersTimeout: 10_000,
  });
  logger.info('🔗 safeFetch: undici keep-alive dispatcher initialized (30s idle, 50 conn/origin)');
} catch (err) {
  logger.warn('safeFetch: undici Agent unavailable, falling back to default fetch agent (4s keep-alive)', err);
}

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

  // BUGS.md L12: plain http is only acceptable for local development
  // (federating with a dockerized peer). In production it invites
  // downgrade/MITM of fetched actors and posts.
  const allowHttp = process.env.NODE_ENV !== 'production';
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new Error(`Blocked protocol: ${url.protocol}`);
  }

  // `new URL('http://[::1]').hostname` returns `'[::1]'` (with brackets) on
  // modern Node (WHATWG URL spec) - strip them before pattern checks.
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
  // ::1 loopback / :: unspecified
  if (lower === '::1' || lower === '::') return true;
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) - check the embedded v4
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (mapped && isBlockedIPv4(mapped[1])) return true;
  // 6to4 (2002::/16): the first two hextets after `2002:` encode the
  // tunnelled IPv4. If that v4 is private/loopback/link-local, this address
  // routes (via 6to4 gateways on legacy hosts) to an internal target. Decode
  // and re-check via isBlockedIPv4.
  const sixToFour = lower.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
  if (sixToFour) {
    const hi = parseInt(sixToFour[1], 16);
    const lo = parseInt(sixToFour[2], 16);
    if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      if (isBlockedIPv4(v4)) return true;
    }
  }
  // fc00::/7  Unique Local Addresses (fc + fd)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // fe80::/10  link-local (second nibble 8/9/a/b)
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  // fec0::/10  site-local - deprecated by RFC 3879 but still classed
  // as private; block defensively (second nibble c/d/e/f).
  if (lower.startsWith('fec') || lower.startsWith('fed') || lower.startsWith('fee') || lower.startsWith('fef')) return true;
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
 * DNS failures (NXDOMAIN, refused) are treated as benign - they aren't a
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

// safeFetch - the canonical helper for outbound HTTP from federation code.

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
  /**
   * Max response body size in bytes. If `Content-Length` is present and
   * exceeds this, the response is rejected immediately without reading
   * the body. For chunked responses with no `Content-Length`, the body
   * is streamed and the response is rejected (with `body.cancel()`) on
   * overflow. Default: 5_000_000 (5 MB). Pass `Infinity` to opt out.
   *
   * Federation payloads are typically small (≤ a few KB); 5 MB allows
   * generous outbox pages without enabling a remote attacker to fill
   * memory by serving a 1 GB body.
   */
  maxBodyBytes?: number;
}

/**
 * Headers we strip BEFORE replaying a request to a redirect target on a
 * different origin (host or scheme change). This mirrors browser behavior
 * for `Authorization` and `Cookie`, and additionally covers HTTP Signature
 * headers, which were signed over the original `(request-target)` and
 * `Host` and are therefore both useless and a signed-bytes leak when sent
 * to a different host.
 */
const CROSS_ORIGIN_STRIPPED_HEADERS = new Set([
  'authorization',
  'cookie',
  'signature',
  'digest',
]);

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
 *      link-local / loopback / 6to4-embedded-private range.
 *   4. DNS A and AAAA resolutions of the hostname are not in any private
 *      range (defends against DNS rebinding and CNAMEs to internal hosts).
 *   5. Redirects are followed MANUALLY with a re-validation per hop
 *      (cannot bypass via `301 → http://internal/`).
 *   6. Each attempt is bounded by `timeoutMs` (default 10s).
 *   7. Response body size is capped at `maxBodyBytes` (default 5 MB) via
 *      a `Content-Length` pre-check + streamed-counter overflow on
 *      chunked responses.
 *
 * Header propagation across redirects: by default, `Authorization`,
 * `Cookie`, `Signature`, and `Digest` are STRIPPED on cross-origin hops
 * (host or scheme change). This mirrors browser behavior for auth
 * headers and prevents HTTP-Signature leaks - the signature was bound
 * to the original `(request-target)` / `Host`, so replaying it to the
 * redirect target would both fail to verify and leak the signed bytes
 * to that target. Non-auth headers (e.g. `Accept`, `User-Agent`) are
 * preserved on every hop.
 *
 * What this DOES NOT guarantee:
 *   - DNS TOCTOU between this check and the kernel's connect() (mitigated
 *     in practice by node returning cached lookups within a request, but
 *     a fully paranoid setup would also pin the IP via `lookup` in
 *     `agent`. Out of scope here.).
 */
export async function safeFetch(urlString: string, options: SafeFetchOptions = {}): Promise<Response> {
  const {
    maxRedirects = 3,
    timeoutMs = 10_000,
    maxBodyBytes = 5_000_000,
    signal: externalSignal,
    ...fetchInit
  } = options;

  let currentUrl = urlString;
  let currentHeaders: HeadersInit | undefined = fetchInit.headers;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = validateExternalUrl(currentUrl);
    await validateResolvedAddress(url.hostname);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`safeFetch: timeout after ${timeoutMs}ms`)), timeoutMs);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        ...fetchInit,
        headers: currentHeaders,
        redirect: 'manual',
        signal: linkSignals(externalSignal, ac),
        // `dispatcher` is an undici-specific option that Node's native fetch
        // forwards through. Cast to any so the standard RequestInit type
        // (which lacks `dispatcher`) doesn't complain. When the dispatcher
        // is undefined (no undici), this is a no-op and fetch uses the
        // default global agent.
        ...(federationDispatcher ? { dispatcher: federationDispatcher } : {}),
      } as any);
    } finally {
      clearTimeout(timer);
    }

    // 3xx with a Location header → follow manually after re-validation.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      // Malformed redirect (3xx without Location): treat as terminal response,
      // but still enforce the body-size cap so a hostile peer can't stream
      // unbounded bytes through a 301/302 without Location.
      if (!location) return enforceBodySize(response, maxBodyBytes);
      // Drain the redirect response body so node doesn't leak the socket.
      try { await response.body?.cancel(); } catch { /* noop */ }
      const nextUrl = new URL(location, currentUrl).href;
      const nextUrlParsed = new URL(nextUrl);

      // Strip auth-sensitive headers if the hop is cross-origin.
      const isCrossOrigin = nextUrlParsed.host !== url.host || nextUrlParsed.protocol !== url.protocol;
      if (isCrossOrigin && currentHeaders) {
        currentHeaders = stripSensitiveHeaders(currentHeaders);
      }

      logger.info(`🔁 safeFetch redirect ${hop + 1}/${maxRedirects}: ${url.href} → ${nextUrl}${isCrossOrigin ? ' [cross-origin, stripped auth headers]' : ''}`);
      currentUrl = nextUrl;
      continue;
    }

    return enforceBodySize(response, maxBodyBytes);
  }

  throw new Error(`safeFetch: too many redirects (max=${maxRedirects})`);
}

/**
 * Return a header collection with auth-sensitive entries removed.
 * Accepts any HeadersInit and normalizes the output to a plain Record so
 * downstream `fetch` calls treat it the same as the original.
 */
function stripSensitiveHeaders(headers: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  const append = (name: string, value: string) => {
    if (!CROSS_ORIGIN_STRIPPED_HEADERS.has(name.toLowerCase())) {
      out[name] = value;
    }
  };
  if (headers instanceof Headers) {
    headers.forEach((value, name) => append(name, value));
  } else if (Array.isArray(headers)) {
    for (const [name, value] of headers) append(name, value);
  } else {
    for (const [name, value] of Object.entries(headers)) {
      if (value != null) append(name, String(value));
    }
  }
  return out;
}

/**
 * Wrap a response so its body is rejected if it exceeds `maxBytes`.
 *
 * Strategy:
 *   1. Pre-check `Content-Length` header - if it advertises more than
 *      `maxBytes`, return a rejected response immediately (cheap path).
 *   2. For chunked / no-Content-Length responses, wrap the body in a
 *      TransformStream that counts bytes and errors on overflow.
 *
 * The returned Response is a normal Response - callers use it as usual
 * (`await res.text()`, `await res.json()`) and the overflow surfaces as
 * a thrown error from the body consumer.
 */
function enforceBodySize(response: Response, maxBytes: number): Response {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return response;

  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      try { response.body?.cancel(); } catch { /* noop */ }
      throw new Error(`safeFetch: response body too large (${declaredBytes} > ${maxBytes})`);
    }
  }

  if (!response.body) return response;

  let received = 0;
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        controller.error(new Error(`safeFetch: response body exceeded ${maxBytes} bytes (received ${received})`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(counting), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// Internal helper exported for tests only. Treat as `@internal`.
export const __test__ = { isBlockedIPv4, isBlockedIPv6 };
