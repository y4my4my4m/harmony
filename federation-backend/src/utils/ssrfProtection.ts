/**
 * SSRF Protection
 *
 * Validates URLs before making outbound HTTP requests to prevent
 * Server-Side Request Forgery against internal networks, cloud
 * metadata endpoints, and other sensitive destinations.
 */

import { logger } from './logger.js';
import dns from 'dns';
import { promisify } from 'util';

const dnsResolve = promisify(dns.resolve4);

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

  const hostname = url.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Blocked hostname: ${hostname}`);
  }

  // Block raw IP addresses that are private
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    if (isBlockedIPv4(hostname)) {
      throw new Error(`Blocked private IP: ${hostname}`);
    }
  }

  // Block IPv6 loopback / private (url.hostname strips brackets from IPv6)
  // Only match actual IPv6 literals (contain ':'), not regular hostnames starting with 'fc'/'fd'
  if (hostname.includes(':')) {
    if (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80')) {
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
  const lower = hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(lower)) {
    throw new Error(`Blocked hostname: ${lower}`);
  }

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) {
    if (isBlockedIPv4(lower)) {
      throw new Error(`Blocked private IP: ${lower}`);
    }
  }

  if (lower.includes(':')) {
    if (lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) {
      throw new Error(`Blocked private IPv6: ${lower}`);
    }
  }
}

/**
 * Resolve hostname via DNS and verify the resolved IPs are not private.
 * Use this as an additional check before fetching user-controlled URLs.
 */
export async function validateResolvedAddress(hostname: string): Promise<void> {
  try {
    const addresses = await dnsResolve(hostname);
    for (const ip of addresses) {
      if (isBlockedIPv4(ip)) {
        logger.warn(`🚫 SSRF: ${hostname} resolves to private IP ${ip}`);
        throw new Error(`Hostname ${hostname} resolves to blocked private IP`);
      }
    }
  } catch (err: any) {
    if (err.message?.includes('blocked')) throw err;
    // DNS resolution failure is not a security concern here — the fetch will fail on its own.
  }
}
