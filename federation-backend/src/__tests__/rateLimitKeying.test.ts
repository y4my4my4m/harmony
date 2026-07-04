import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { instanceKeyFromRequest } from '../middleware/rateLimit.js';

function fakeReq(body: unknown, ip = '203.0.113.7'): Request {
  return { body, ip } as unknown as Request;
}

describe('instanceKeyFromRequest', () => {
  it('keys by the actor domain for string actors', () => {
    const req = fakeReq({ actor: 'https://Mastodon.Example/users/alice' });
    expect(instanceKeyFromRequest(req)).toBe('mastodon.example');
  });

  it('keys by the actor domain for object actors', () => {
    const req = fakeReq({ actor: { id: 'https://misskey.example/users/9abc' } });
    expect(instanceKeyFromRequest(req)).toBe('misskey.example');
  });

  it('falls back to IP when the actor is missing', () => {
    expect(instanceKeyFromRequest(fakeReq({}))).toBe('ip:203.0.113.7');
  });

  it('falls back to IP when the actor URL is unparseable', () => {
    expect(instanceKeyFromRequest(fakeReq({ actor: 'not a url' }))).toBe('ip:203.0.113.7');
  });

  it('two instances behind one IP get distinct keys', () => {
    const a = instanceKeyFromRequest(fakeReq({ actor: 'https://a.example/u/x' }, '198.51.100.1'));
    const b = instanceKeyFromRequest(fakeReq({ actor: 'https://b.example/u/y' }, '198.51.100.1'));
    expect(a).not.toBe(b);
  });
});
