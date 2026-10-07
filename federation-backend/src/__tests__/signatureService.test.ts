import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: vi.fn(),
}))
vi.mock('../middleware/errorHandler.js', () => ({
  AppError: class AppError extends Error {
    statusCode: number
    constructor(statusCode: number, message: string) {
      super(message)
      this.statusCode = statusCode
    }
  },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch: vi.fn(),
}))
const instanceActor = vi.hoisted(() => ({ privateKey: '', fail: false }))
vi.mock('../activitypub/InstanceActor.js', () => ({
  signAsInstanceActor: vi.fn(async (url: string, method: string, body: unknown) => {
    if (instanceActor.fail) throw new Error('instance_actor_keys unavailable')
    const { SignatureService } = await import('../activitypub/SignatureService.js')
    return SignatureService.signWithKey(url, method, body, 'https://harmony.test/users/instance.actor#main-key', instanceActor.privateKey)
  }),
}))

import { SignatureService, __publicKeyCache } from '../activitypub/SignatureService.js'
import { safeFetch } from '../utils/ssrfProtection.js'

describe('SignatureService', () => {
  describe('generateKeyPair', () => {
    it('generates a valid RSA key pair', async () => {
      const { publicKey, privateKey } = await SignatureService.generateKeyPair()
      expect(publicKey).toContain('-----BEGIN PUBLIC KEY-----')
      expect(privateKey).toContain('-----BEGIN PRIVATE KEY-----')
    })

    it('generates keys that can sign and verify', async () => {
      const { publicKey, privateKey } = await SignatureService.generateKeyPair()

      const data = 'test data to sign'
      const sign = crypto.createSign('SHA256')
      sign.update(data)
      sign.end()
      const signature = sign.sign(privateKey, 'base64')

      const verify = crypto.createVerify('SHA256')
      verify.update(data)
      verify.end()
      expect(verify.verify(publicKey, signature, 'base64')).toBe(true)
    })

    it('generates unique key pairs each time', async () => {
      const key1 = await SignatureService.generateKeyPair()
      const key2 = await SignatureService.generateKeyPair()
      expect(key1.publicKey).not.toBe(key2.publicKey)
      expect(key1.privateKey).not.toBe(key2.privateKey)
    })
  })

  describe('createDigest', () => {
    it('creates SHA-256 digest for a string body', () => {
      const body = '{"type":"Follow"}'
      const digest = SignatureService.createDigest(body)
      expect(digest).toMatch(/^SHA-256=/)
      const hash = crypto.createHash('sha256').update(body).digest('base64')
      expect(digest).toBe(`SHA-256=${hash}`)
    })

    it('creates SHA-256 digest for an object body', () => {
      const body = { type: 'Follow', actor: 'https://example.com/users/alice' }
      const digest = SignatureService.createDigest(body)
      const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('base64')
      expect(digest).toBe(`SHA-256=${hash}`)
    })

    it('produces different digests for different bodies', () => {
      const d1 = SignatureService.createDigest('body1')
      const d2 = SignatureService.createDigest('body2')
      expect(d1).not.toBe(d2)
    })

    it('produces same digest for same body', () => {
      const body = { key: 'value' }
      expect(SignatureService.createDigest(body)).toBe(SignatureService.createDigest(body))
    })
  })

  describe('verifyActorMatch', () => {
    it('returns true for matching URLs', () => {
      expect(
        SignatureService.verifyActorMatch(
          'https://mastodon.social/users/alice',
          'https://mastodon.social/users/alice'
        )
      ).toBe(true)
    })

    it('returns false for different users', () => {
      expect(
        SignatureService.verifyActorMatch(
          'https://mastodon.social/users/alice',
          'https://mastodon.social/users/bob'
        )
      ).toBe(false)
    })

    it('returns false for different domains (spoofing attempt)', () => {
      expect(
        SignatureService.verifyActorMatch(
          'https://evil.example.com/users/alice',
          'https://mastodon.social/users/alice'
        )
      ).toBe(false)
    })

    it('normalizes trailing slashes', () => {
      expect(
        SignatureService.verifyActorMatch(
          'https://mastodon.social/users/alice/',
          'https://mastodon.social/users/alice'
        )
      ).toBe(true)
    })

    it('ignores query parameters and fragments', () => {
      expect(
        SignatureService.verifyActorMatch(
          'https://mastodon.social/users/alice?foo=bar',
          'https://mastodon.social/users/alice'
        )
      ).toBe(true)
    })

    it('handles invalid URLs gracefully (different strings = no match)', () => {
      expect(
        SignatureService.verifyActorMatch('not-a-url', 'also-not-a-url')
      ).toBe(false)
    })

    it('handles identical invalid URLs gracefully', () => {
      expect(
        SignatureService.verifyActorMatch('not-a-url', 'not-a-url')
      ).toBe(true)
    })

    it('detects cross-protocol mismatch', () => {
      expect(
        SignatureService.verifyActorMatch(
          'http://mastodon.social/users/alice',
          'https://mastodon.social/users/alice'
        )
      ).toBe(false)
    })

    it('rejects same-domain cross-user signature in strict mode (default)', () => {
      // Regression for BUGS.md C1: a legitimate signer on a host must not be
      // able to claim activity.actor for any *other* user on the same host.
      expect(
        SignatureService.verifyActorMatch(
          'https://mastodon.social/users/bob',
          'https://mastodon.social/users/alice'
        )
      ).toBe(false)
    })

    it('accepts same-domain cross-user signature only when explicitly opted in (Group delegation)', () => {
      // Server-inbox path (Lemmy-style Group activity signed by a moderator
      // on the same host) - only safe when caller opts in.
      expect(
        SignatureService.verifyActorMatch(
          'https://lemmy.example/c/news',
          'https://lemmy.example/u/alice',
          true,
        )
      ).toBe(true)
    })

    it('still rejects cross-domain even when delegation is allowed', () => {
      expect(
        SignatureService.verifyActorMatch(
          'https://evil.example.com/users/bob',
          'https://mastodon.social/users/alice',
          true,
        )
      ).toBe(false)
    })
  })

  describe('signRequest + verifySignature roundtrip', () => {
    let keyPair: { publicKey: string; privateKey: string }

    beforeEach(async () => {
      keyPair = await SignatureService.generateKeyPair()

      const { getSupabaseClient } = await import('../config/supabase.js')

      const createChainedMock = (resolveValue: any) => {
        const mock: any = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue(resolveValue),
        }
        mock.select.mockReturnValue(mock)
        mock.eq.mockReturnValue(mock)
        return mock
      }

      ;(getSupabaseClient as any).mockReturnValue({
        from: vi.fn((table: string) => {
          if (table === 'profiles') {
            return createChainedMock({
              data: { username: 'alice', domain: 'harmony.test' },
              error: null,
            })
          }
          if (table === 'user_private_keys') {
            return createChainedMock({
              data: { private_key: keyPair.privateKey },
              error: null,
            })
          }
          return createChainedMock({ data: null, error: null })
        }),
      })
    })

    it('signs a POST request and produces correct headers', async () => {
      const body = { type: 'Follow' }
      const result = await SignatureService.signRequest(
        'https://remote.server/inbox',
        'POST',
        body,
        'user-123'
      )

      expect(result.headers).toHaveProperty('Signature')
      expect(result.headers).toHaveProperty('Date')
      expect(result.headers).toHaveProperty('Host', 'remote.server')
      expect(result.headers).toHaveProperty('Digest')
      expect(result.headers.Signature).toContain('keyId="https://harmony.test/users/alice#main-key"')
      expect(result.headers.Signature).toContain('algorithm="rsa-sha256"')
      expect(result.headers.Signature).toContain('(request-target)')
    })

    it('signs a GET request without Digest header', async () => {
      const result = await SignatureService.signRequest(
        'https://remote.server/users/bob',
        'GET',
        null,
        'user-123'
      )

      expect(result.headers.Signature).toBeDefined()
      expect(result.headers.Digest).toBeUndefined()
      expect(result.digest).toBeUndefined()
    })

    it('signature includes (request-target) for Misskey compatibility', async () => {
      const result = await SignatureService.signRequest(
        'https://misskey.io/inbox',
        'POST',
        { type: 'Follow' },
        'user-123'
      )
      expect(result.headers.Signature).toContain('(request-target)')
    })
  })

  describe('parseSignatureHeader', () => {
    it('parses a standard Mastodon-style header', () => {
      const parts = SignatureService.parseSignatureHeader(
        'keyId="https://remote.test/users/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="dGVzdA=="'
      )
      expect(parts.keyId).toBe('https://remote.test/users/alice#main-key')
      expect(parts.algorithm).toBe('rsa-sha256')
      expect(parts.headers).toBe('(request-target) host date digest')
      expect(parts.signature).toBe('dGVzdA==')
    })

    it('preserves base64 padding and internal = in signature values', () => {
      const parts = SignatureService.parseSignatureHeader('signature="a=b+c/d=="')
      expect(parts.signature).toBe('a=b+c/d==')
    })

    it('handles commas inside quoted values (keyId is a URI)', () => {
      const parts = SignatureService.parseSignatureHeader(
        'keyId="https://remote.test/users/a,b#main-key",signature="dGVzdA=="'
      )
      expect(parts.keyId).toBe('https://remote.test/users/a,b#main-key')
      expect(parts.signature).toBe('dGVzdA==')
    })

    it('handles unquoted numeric params (created/expires)', () => {
      const parts = SignatureService.parseSignatureHeader(
        'keyId="https://remote.test/users/alice",created=1700000000,expires=1700000300,signature="dGVzdA=="'
      )
      expect(parts.created).toBe('1700000000')
      expect(parts.expires).toBe('1700000300')
    })

    it('tolerates whitespace around separators', () => {
      const parts = SignatureService.parseSignatureHeader(
        'keyId = "https://remote.test/users/alice" , signature = "dGVzdA=="'
      )
      expect(parts.keyId).toBe('https://remote.test/users/alice')
      expect(parts.signature).toBe('dGVzdA==')
    })
  })

  describe('signedApFetch', () => {
    let keyPair: { publicKey: string; privateKey: string }

    const sent = (call: number) => vi.mocked(safeFetch).mock.calls[call][1] as any

    const verifies = (url: string, headers: Record<string, string>) => {
      const params = SignatureService.parseSignatureHeader(headers.Signature)
      const target = new URL(url)
      const signingString = [
        `(request-target): get ${target.pathname}${target.search}`,
        `host: ${headers.Host}`,
        `date: ${headers.Date}`,
      ].join('\n')
      return crypto.createVerify('SHA256').update(signingString).verify(keyPair.publicKey, params.signature, 'base64')
    }

    beforeEach(async () => {
      vi.clearAllMocks()
      keyPair = await SignatureService.generateKeyPair()
      instanceActor.privateKey = keyPair.privateKey
      instanceActor.fail = false
    })

    it('signs every GET as the instance actor, with no unsigned attempt', async () => {
      vi.mocked(safeFetch).mockResolvedValueOnce(new Response('{}', { status: 200 }))

      const res = await SignatureService.signedApFetch('https://remote.test/users/bob?page=1')

      expect(res.status).toBe(200)
      expect(safeFetch).toHaveBeenCalledTimes(1)
      const headers = sent(0).headers as Record<string, string>
      expect(headers.Signature).toContain('keyId="https://harmony.test/users/instance.actor#main-key"')
      expect(headers.Signature).toContain('algorithm="rsa-sha256"')
      expect(headers.Signature).toContain('headers="(request-target) host date"')
      expect(headers.Host).toBe('remote.test')
      expect(verifies('https://remote.test/users/bob?page=1', headers)).toBe(true)
    })

    it('reads an actor from a remote that answers an unsigned GET 400 Missing signature', async () => {
      vi.mocked(safeFetch).mockImplementation(async (_url, init: any) =>
        init?.headers?.Signature
          ? new Response('{"type":"Person"}', { status: 200 })
          : new Response('{"code":400,"message":"Missing signature"}', { status: 400 }))

      const res = await SignatureService.signedApFetch('https://chat.remote.test/users/doesnm')

      expect(res.status).toBe(200)
      expect(safeFetch).toHaveBeenCalledTimes(1)
    })

    it.each([401, 403])('returns %i as received, without an unsigned retry', async (status) => {
      vi.mocked(safeFetch).mockResolvedValueOnce(new Response('', { status }))

      const res = await SignatureService.signedApFetch('https://remote.test/users/bob')

      expect(res.status).toBe(status)
      expect(safeFetch).toHaveBeenCalledTimes(1)
    })

    it('signs each redirect hop for its own target', async () => {
      vi.mocked(safeFetch).mockResolvedValueOnce(new Response('{}', { status: 200 }))

      await SignatureService.signedApFetch('https://remote.test/@bob')

      const hopHeaders = await sent(0).redirectHeaders('https://www.remote.test/users/bob')
      expect(hopHeaders.Host).toBe('www.remote.test')
      expect(hopHeaders.Signature).toContain('keyId="https://harmony.test/users/instance.actor#main-key"')
      expect(verifies('https://www.remote.test/users/bob', hopHeaders)).toBe(true)
    })

    it('sends the GET unsigned when the instance actor key cannot be read', async () => {
      instanceActor.fail = true
      vi.mocked(safeFetch).mockResolvedValueOnce(new Response('{}', { status: 200 }))

      const res = await SignatureService.signedApFetch('https://remote.test/users/bob')

      expect(res.status).toBe(200)
      expect(sent(0).headers.Signature).toBeUndefined()
    })

    it('forwards caller headers, timeout and signal; the signature headers win', async () => {
      vi.mocked(safeFetch).mockResolvedValueOnce(new Response('{}', { status: 200 }))

      const controller = new AbortController()
      await SignatureService.signedApFetch('https://remote.test/users/bob', {
        headers: { 'User-Agent': 'Harmony/1.0', Accept: 'application/json', Host: 'spoofed.test' },
        timeoutMs: 4321,
        signal: controller.signal,
      })

      const init = sent(0)
      expect(init.timeoutMs).toBe(4321)
      expect(init.signal).toBe(controller.signal)
      expect(init.headers['User-Agent']).toBe('Harmony/1.0')
      expect(init.headers.Accept).toBe('application/json')
      expect(init.headers.Host).toBe('remote.test')
    })
  })

  describe('remote key fetches', () => {
    beforeEach(async () => {
      vi.clearAllMocks()
      __publicKeyCache.clear()
      instanceActor.privateKey = (await SignatureService.generateKeyPair()).privateKey
      instanceActor.fail = false
    })

    it('fetches the signer\'s actor document with a signed GET', async () => {
      const signer = await SignatureService.generateKeyPair()
      const actorUrl = 'https://chat.remote.test/users/doesnm'
      const actor = {
        id: actorUrl,
        type: 'Person',
        preferredUsername: 'doesnm',
        publicKey: { id: `${actorUrl}#main-key`, owner: actorUrl, publicKeyPem: signer.publicKey },
      }
      const makeQuery = () => {
        const q: any = {}
        for (const m of ['select', 'eq', 'limit', 'order', 'update', 'upsert']) q[m] = vi.fn(() => q)
        q.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
        q.then = (resolve: any) => resolve({ data: null, error: null })
        return q
      }
      const { getSupabaseClient } = await import('../config/supabase.js')
      ;(getSupabaseClient as any).mockReturnValue({ from: vi.fn(() => makeQuery()) })
      vi.mocked(safeFetch).mockImplementation(async (_url, init: any) => {
        if (!init?.headers?.Signature) return new Response('{"code":400,"message":"Missing signature"}', { status: 400 })
        return new Response(JSON.stringify(actor), {
          status: 200,
          headers: { 'content-type': 'application/activity+json' },
        })
      })

      const date = new Date().toUTCString()
      const signingString = `(request-target): post /inbox\nhost: harmony.test\ndate: ${date}`
      const signature = crypto.createSign('SHA256').update(signingString).sign(signer.privateKey, 'base64')
      const result = await SignatureService.verifySignature(
        `keyId="${actorUrl}#main-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="${signature}"`,
        { host: 'harmony.test', date },
        'POST',
        '/inbox',
      )

      expect(result).toMatchObject({ verified: true, actorUrl })
      expect(vi.mocked(safeFetch).mock.calls[0][0]).toBe(actorUrl)
      expect((vi.mocked(safeFetch).mock.calls[0][1] as any).headers.Signature)
        .toContain('keyId="https://harmony.test/users/instance.actor#main-key"')
    })
  })
})
