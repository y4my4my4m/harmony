import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';

vi.mock('../config/index.js', () => ({
  default: { RATE_LIMIT_WINDOW_MS: 60_000, RATE_LIMIT_MAX_REQUESTS: 100 },
  config: { RATE_LIMIT_WINDOW_MS: 60_000, RATE_LIMIT_MAX_REQUESTS: 100 },
}));
vi.mock('../services/RedisService.js', () => ({ redis: { ready: false } }));

import express from 'express';
import supertest from 'supertest';
import {
  clientIp, discoveryLimiter, signerInstanceKey, instanceInboxLimit, reactionsLimiter, repliesLimiter, repliesStatusLimiter,
} from '../middleware/rateLimit.js';

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

describe('client address behind nginx', () => {
  const app = (trust: string[]) => {
    const a = express()
    a.set('trust proxy', trust)
    a.get('/ip', (req, res) => { res.json({ ip: clientIp(req) }) })
    a.get('/limited', discoveryLimiter, (_req, res) => { res.json({ ok: true }) })
    return a
  }

  it('takes X-Real-IP from a trusted proxy and never X-Forwarded-For', async () => {
    const res = await supertest(app(['loopback', 'uniquelocal']))
      .get('/ip').set('X-Real-IP', '198.51.100.7').set('X-Forwarded-For', '203.0.113.9')
    expect(res.body.ip).toBe('198.51.100.7')

    const xffOnly = await supertest(app(['loopback', 'uniquelocal'])).get('/ip').set('X-Forwarded-For', '203.0.113.9')
    expect(xffOnly.body.ip).not.toBe('203.0.113.9')
  })

  it('ignores X-Real-IP from a peer that is not a trusted proxy', async () => {
    const res = await supertest(app(['192.0.2.1'])).get('/ip').set('X-Real-IP', '198.51.100.7')
    expect(res.body.ip).not.toBe('198.51.100.7')
    expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/)
  })

  it('a client varying X-Forwarded-For stays in one bucket', async () => {
    const a = app(['loopback'])
    for (let i = 0; i < 30; i++) {
      const res = await supertest(a).get('/limited').set('X-Real-IP', '198.51.100.20').set('X-Forwarded-For', `203.0.113.${i}`)
      expect(res.status).toBe(200)
    }
    const res = await supertest(a).get('/limited').set('X-Real-IP', '198.51.100.20').set('X-Forwarded-For', '203.0.113.250')
    expect(res.status).toBe(429)
  })
})

describe('reply and reaction buckets', () => {
  const app = () => {
    const a = express()
    a.set('trust proxy', ['loopback'])
    a.post('/lookup-user', discoveryLimiter, (_req, res) => { res.json({ ok: true }) })
    a.post('/fetch-replies', repliesLimiter, (_req, res) => { res.json({ ok: true }) })
    a.get('/fetch-replies/status', repliesStatusLimiter, (_req, res) => { res.json({ ok: true }) })
    a.post('/fetch-reactions', reactionsLimiter, (_req, res) => { res.json({ ok: true }) })
    return a
  }

  it('an exhausted discovery budget leaves reply, status and reaction fetches answering', async () => {
    const a = app()
    const ip = '198.51.100.40'
    for (let i = 0; i < 30; i++) await supertest(a).post('/lookup-user').set('X-Real-IP', ip)
    expect((await supertest(a).post('/lookup-user').set('X-Real-IP', ip)).status).toBe(429)

    expect((await supertest(a).post('/fetch-replies').set('X-Real-IP', ip)).status).toBe(200)
    expect((await supertest(a).get('/fetch-replies/status').set('X-Real-IP', ip)).status).toBe(200)
    expect((await supertest(a).post('/fetch-reactions').set('X-Real-IP', ip)).status).toBe(200)
  })

  it('reaction refreshes do not spend the reply budget', async () => {
    const a = app()
    const ip = '198.51.100.41'
    for (let i = 0; i < 60; i++) await supertest(a).post('/fetch-reactions').set('X-Real-IP', ip)
    expect((await supertest(a).post('/fetch-reactions').set('X-Real-IP', ip)).status).toBe(429)
    expect((await supertest(a).post('/fetch-replies').set('X-Real-IP', ip)).status).toBe(200)
  })

  it('refuses the 31st reply fetch in a minute with Retry-After', async () => {
    const a = app()
    const ip = '198.51.100.42'
    for (let i = 0; i < 30; i++) {
      expect((await supertest(a).post('/fetch-replies').set('X-Real-IP', ip)).status).toBe(200)
    }
    const refused = await supertest(a).post('/fetch-replies').set('X-Real-IP', ip)
    expect(refused.status).toBe(429)
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
    expect(refused.body.retryAfter).toBe(Number(refused.headers['retry-after']))
  })
})
