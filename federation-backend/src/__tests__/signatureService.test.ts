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

import { SignatureService } from '../activitypub/SignatureService.js'

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
})
