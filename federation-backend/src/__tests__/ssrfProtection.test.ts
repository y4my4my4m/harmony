import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the logger so test output isn't noisy.
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Tests intercept `dns.promises.resolve4` / `resolve6` via `vi.spyOn` so no
// real DNS round-trips occur. The production code calls these via
// `dns.promises.X` (not via a captured `promisify(dns.X)` ref) precisely so
// the spies bind correctly.
import dns from 'dns';

import {
  validateExternalUrl,
  validateExternalHostname,
  validateResolvedAddress,
  safeFetch,
  __test__,
} from '../utils/ssrfProtection.js';

const { isBlockedIPv4, isBlockedIPv6 } = __test__;

// ---------------------------------------------------------------------------
// Pure IP-range predicates
// ---------------------------------------------------------------------------
describe('isBlockedIPv4', () => {
  it.each([
    ['127.0.0.1'],     // loopback
    ['127.255.255.254'],
    ['10.0.0.1'],      // RFC1918 /8
    ['10.255.255.255'],
    ['172.16.0.1'],    // RFC1918 /12 lower edge
    ['172.31.255.254'],// RFC1918 /12 upper edge
    ['192.168.0.1'],   // RFC1918 /16
    ['169.254.169.254'],// cloud metadata / link-local
    ['0.0.0.0'],
    ['100.64.0.1'],    // CGNAT
    ['198.18.0.1'],    // benchmarking
  ])('blocks %s', (ip) => {
    expect(isBlockedIPv4(ip)).toBe(true);
  });

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['172.32.0.1'],    // just outside RFC1918 /12
    ['172.15.255.254'],// just below RFC1918 /12
    ['100.63.255.254'],// just below CGNAT /10
    ['100.128.0.1'],   // just above CGNAT /10
  ])('allows %s', (ip) => {
    expect(isBlockedIPv4(ip)).toBe(false);
  });

  it('treats malformed inputs as not-blocked (caller handles separately)', () => {
    expect(isBlockedIPv4('not-an-ip')).toBe(false);
    expect(isBlockedIPv4('1.2.3')).toBe(false);
    expect(isBlockedIPv4('1.2.3.4.5')).toBe(false);
  });
});

describe('isBlockedIPv6', () => {
  it.each([
    ['::1'],
    ['::'],
    ['::ffff:127.0.0.1'],            // v4-mapped loopback
    ['::ffff:169.254.169.254'],      // v4-mapped cloud metadata
    ['fc00::1'],                      // ULA
    ['fd00::abcd'],
    ['fe80::1'],                      // link-local
    ['febf::1'],
  ])('blocks %s', (ip) => {
    expect(isBlockedIPv6(ip)).toBe(true);
  });

  it.each([
    ['2001:db8::1'],                  // documentation/public
    ['2606:4700:4700::1111'],         // Cloudflare DNS
    ['::ffff:8.8.8.8'],               // v4-mapped public
  ])('allows %s', (ip) => {
    expect(isBlockedIPv6(ip)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateExternalUrl
// ---------------------------------------------------------------------------
describe('validateExternalUrl', () => {
  it('accepts plain https public URLs', () => {
    const u = validateExternalUrl('https://example.com/path?q=1');
    expect(u.hostname).toBe('example.com');
  });

  it('accepts http (federation may serve over http in dev)', () => {
    expect(() => validateExternalUrl('http://example.com')).not.toThrow();
  });

  it.each([
    ['file:///etc/passwd'],
    ['ftp://example.com'],
    ['gopher://example.com'],
    ['dict://example.com'],
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
  ])('rejects scheme %s', (url) => {
    expect(() => validateExternalUrl(url)).toThrow(/Blocked protocol|Invalid URL/);
  });

  it('rejects blocklisted hostnames', () => {
    expect(() => validateExternalUrl('http://localhost/x')).toThrow(/Blocked hostname/);
    expect(() => validateExternalUrl('http://metadata.google.internal/x')).toThrow(/Blocked hostname/);
  });

  it('rejects literal private IPv4', () => {
    expect(() => validateExternalUrl('http://10.0.0.5/admin')).toThrow(/Blocked private IP/);
    expect(() => validateExternalUrl('http://169.254.169.254/latest/meta-data')).toThrow(/Blocked private IP/);
  });

  it('allows public IPv4 literals', () => {
    expect(() => validateExternalUrl('http://8.8.8.8')).not.toThrow();
  });

  it('rejects literal private IPv6', () => {
    expect(() => validateExternalUrl('http://[::1]/')).toThrow(/Blocked private IPv6/);
    expect(() => validateExternalUrl('http://[fc00::1]/')).toThrow(/Blocked private IPv6/);
    expect(() => validateExternalUrl('http://[fe80::1]/')).toThrow(/Blocked private IPv6/);
  });

  it('rejects garbage URLs cleanly', () => {
    expect(() => validateExternalUrl('not a url')).toThrow(/Invalid URL/);
  });
});

// ---------------------------------------------------------------------------
// validateExternalHostname
// ---------------------------------------------------------------------------
describe('validateExternalHostname', () => {
  it('accepts public hostnames', () => {
    expect(() => validateExternalHostname('example.com')).not.toThrow();
  });

  it('rejects blocklisted hostnames', () => {
    expect(() => validateExternalHostname('localhost')).toThrow(/Blocked hostname/);
  });

  it('rejects literal private IPs (both families)', () => {
    expect(() => validateExternalHostname('127.0.0.1')).toThrow();
    expect(() => validateExternalHostname('::1')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateResolvedAddress  - these tests mock dns.resolve4 / dns.resolve6
// ---------------------------------------------------------------------------
describe('validateResolvedAddress', () => {
  let resolve4Spy: ReturnType<typeof vi.spyOn>;
  let resolve6Spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resolve4Spy = vi.spyOn(dns.promises, 'resolve4') as any;
    resolve6Spy = vi.spyOn(dns.promises, 'resolve6') as any;
  });

  afterEach(() => {
    resolve4Spy.mockRestore();
    resolve6Spy.mockRestore();
  });

  const mockResolve = (
    v4: string[] | Error,
    v6: string[] | Error = new Error('ENOTFOUND'),
  ) => {
    resolve4Spy.mockImplementation(async () => {
      if (v4 instanceof Error) throw v4;
      return v4 as any;
    });
    resolve6Spy.mockImplementation(async () => {
      if (v6 instanceof Error) throw v6;
      return v6 as any;
    });
  };

  it('passes when IPv4 resolutions are all public', async () => {
    mockResolve(['8.8.8.8', '1.1.1.1']);
    await expect(validateResolvedAddress('public.example')).resolves.toBeUndefined();
  });

  it('rejects when any IPv4 resolution is private', async () => {
    mockResolve(['8.8.8.8', '10.0.0.5']);
    await expect(validateResolvedAddress('mixed.example')).rejects.toThrow(/blocked private IP/);
  });

  it('rejects cloud-metadata rebinding (single A record at 169.254.169.254)', async () => {
    mockResolve(['169.254.169.254']);
    await expect(validateResolvedAddress('attacker.example')).rejects.toThrow(/blocked private IP/);
  });

  it('rejects IPv6 ULA result', async () => {
    mockResolve(new Error('NODATA'), ['fc00::1']);
    await expect(validateResolvedAddress('v6.example')).rejects.toThrow(/blocked private IP/);
  });

  it('treats DNS failures as benign (upstream fetch will fail naturally)', async () => {
    mockResolve(new Error('NXDOMAIN'), new Error('NXDOMAIN'));
    await expect(validateResolvedAddress('nope.example')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// safeFetch
// ---------------------------------------------------------------------------
describe('safeFetch', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let resolve4Spy: ReturnType<typeof vi.spyOn>;
  let resolve6Spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch') as any;
    resolve4Spy = vi.spyOn(dns.promises, 'resolve4') as any;
    resolve6Spy = vi.spyOn(dns.promises, 'resolve6') as any;
    // Default: hostnames resolve to a benign public IPv4, no AAAA.
    resolve4Spy.mockResolvedValue(['8.8.8.8'] as any);
    resolve6Spy.mockRejectedValue(new Error('NODATA'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resolve4Spy.mockRestore();
    resolve6Spy.mockRestore();
  });

  const mockResponse = (init: { status: number; headers?: Record<string, string>; body?: string } = { status: 200 }) =>
    new Response(init.body ?? null, { status: init.status, headers: init.headers });

  it('returns a successful direct response', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ status: 200, body: 'ok' }) as any);
    const res = await safeFetch('https://public.example/path');
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('rejects javascript: URLs without making a request', async () => {
    await expect(safeFetch('javascript:alert(1)')).rejects.toThrow(/Blocked protocol|Invalid URL/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects URL pointing at a literal private IP without making a request', async () => {
    await expect(safeFetch('http://169.254.169.254/latest/meta-data/iam')).rejects.toThrow(/Blocked private IP/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects when hostname resolves only to private IPs', async () => {
    resolve4Spy.mockResolvedValue(['10.0.0.5'] as any);
    await expect(safeFetch('https://internal.example/admin')).rejects.toThrow(/blocked private IP/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('follows redirects manually and re-validates each hop', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ status: 302, headers: { location: 'https://second.example/x' } }) as any)
      .mockResolvedValueOnce(mockResponse({ status: 200, body: 'final' }) as any);
    const res = await safeFetch('https://first.example/a');
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Second hop should re-validate via DNS - resolve4 was called twice
    expect(resolve4Spy).toHaveBeenCalledTimes(2);
  });

  it('rejects a redirect to a private IP literal', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ status: 302, headers: { location: 'http://10.0.0.5/admin' } }) as any,
    );
    await expect(safeFetch('https://first.example/a')).rejects.toThrow(/Blocked private IP/);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('rejects a redirect to a hostname that resolves to private (DNS rebinding)', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ status: 302, headers: { location: 'https://rebound.example/' } }) as any);
    resolve4Spy
      .mockResolvedValueOnce(['8.8.8.8'] as any)   // first hop OK
      .mockResolvedValueOnce(['10.0.0.5'] as any); // second hop is private
    await expect(safeFetch('https://first.example/a')).rejects.toThrow(/blocked private IP/);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(resolve4Spy).toHaveBeenCalledTimes(2);
  });

  it('caps redirect chain length', async () => {
    fetchSpy.mockImplementation(async () =>
      mockResponse({ status: 302, headers: { location: 'https://next.example/' } }) as any,
    );
    await expect(safeFetch('https://start.example/', { maxRedirects: 2 })).rejects.toThrow(/too many redirects/);
    // maxRedirects=2 → 3 hops attempted (initial + 2) before giving up
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  // Helper: fetch impl that rejects when the passed signal aborts (either
  // already-aborted or aborts later). Mirrors real fetch's contract.
  const abortableFetchImpl = (_url: any, init: any) =>
    new Promise((_resolve, reject) => {
      if (init.signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) as any;

  it('aborts via the internal timeout', async () => {
    fetchSpy.mockImplementation(abortableFetchImpl);
    await expect(safeFetch('https://slow.example/', { timeoutMs: 10 })).rejects.toThrow(/aborted/);
  });

  it('propagates an external AbortSignal', async () => {
    const ac = new AbortController();
    fetchSpy.mockImplementation(abortableFetchImpl);
    const p = safeFetch('https://slow.example/', { signal: ac.signal });
    // Wait a microtask so safeFetch reaches the fetch() call before we abort -
    // otherwise the abort happens during the `await validateResolvedAddress`
    // phase, the linkSignals branch fires `internal.abort()` pre-fetch, and
    // we're testing a different code path.
    await Promise.resolve();
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
});
