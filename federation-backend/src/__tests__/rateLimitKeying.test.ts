import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';

vi.mock('../config/index.js', () => ({
  default: { RATE_LIMIT_WINDOW_MS: 60_000, RATE_LIMIT_MAX_REQUESTS: 100 },
  config: { RATE_LIMIT_WINDOW_MS: 60_000, RATE_LIMIT_MAX_REQUESTS: 100 },
}));
vi.mock('../services/RedisService.js', () => ({ redis: { ready: false } }));

import { signerInstanceKey, instanceInboxLimit } from '../middleware/rateLimit.js';

type FakeRes = Response & { statusCode: number; body: any; headers: Record<string, any> };

function fakeRes(): FakeRes {
  const res: any = { statusCode: 200, headers: {} as Record<string, unknown>, body: undefined };
  res.setHeader = (k: string, v: unknown) => { res.headers[k] = v; };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res as FakeRes;
}

describe('signerInstanceKey', () => {
  it('keys by the verified signer host', () => {
    expect(signerInstanceKey('https://Mastodon.Example/users/alice', '203.0.113.7')).toBe('mastodon.example');
  });

  it('falls back to the source IP without a verified signer', () => {
    expect(signerInstanceKey(null, '203.0.113.7')).toBe('ip:203.0.113.7');
    expect(signerInstanceKey(undefined, undefined)).toBe('ip:unknown');
  });

  it('falls back to the source IP for an unparseable signer', () => {
    expect(signerInstanceKey('not a url', '203.0.113.7')).toBe('ip:203.0.113.7');
  });
});

describe('instanceInboxLimit', () => {
  it('refuses the 61st activity from one signer host within the window', async () => {
    for (let i = 0; i < 60; i++) {
      expect(await instanceInboxLimit(fakeRes(), 'busy.example')).toBe(true);
    }
    const res = fakeRes();
    expect(await instanceInboxLimit(res, 'busy.example')).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBeGreaterThan(0);
  });

  it('keeps budgets of distinct signer hosts apart', async () => {
    for (let i = 0; i < 61; i++) await instanceInboxLimit(fakeRes(), 'noisy.example');
    expect(await instanceInboxLimit(fakeRes(), 'quiet.example')).toBe(true);
  });
});
