import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

// Inbound RFC 9421 HTTP Message Signatures. Signature bases are checked
// against RFC 9421 §2.5 and digests against RFC 9530; the requests below are
// signed the way Mastodon 4.7 and Fedify sign theirs.

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: vi.fn() }))
vi.mock('../middleware/errorHandler.js', () => ({ AppError: class extends Error {} }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../utils/ssrfProtection.js', () => ({ safeFetch: vi.fn(async () => new Response('', { status: 404 })) }))
vi.mock('../activitypub/InstanceActor.js', () => ({
  signAsInstanceActor: vi.fn(async () => ({ headers: {} })),
}))

import {
  contentDigestMatches,
  coversRequest,
  parseMessageSignature,
  parseSfDictionary,
  signatureBase,
} from '../activitypub/messageSignatures.js'
import { SignatureService, __publicKeyCache } from '../activitypub/SignatureService.js'
import { getSupabaseClient } from '../config/supabase.js'

describe('signatureBase', () => {
  it('reproduces the RFC 9421 §2.5 example', () => {
    const sig = parseMessageSignature(
      'sig1=("@method" "@authority" "@path" "content-digest" "content-length" "content-type");created=1618884473;keyid="test-key-rsa-pss"',
      'sig1=:dGVzdA==:',
    )
    if ('error' in sig) throw new Error(sig.error)

    const base = signatureBase(sig, {
      method: 'POST',
      scheme: 'https',
      target: '/foo?param=Value&Pet=dog',
      headers: {
        host: 'example.com',
        date: 'Tue, 20 Apr 2021 02:07:55 GMT',
        'content-type': 'application/json',
        'content-digest': 'sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
        'content-length': '18',
      },
    })

    expect(base).toBe([
      '"@method": POST',
      '"@authority": example.com',
      '"@path": /foo',
      '"content-digest": sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
      '"content-length": 18',
      '"content-type": application/json',
      '"@signature-params": ("@method" "@authority" "@path" "content-digest" "content-length" "content-type");created=1618884473;keyid="test-key-rsa-pss"',
    ].join('\n'))
  })

  it('derives @target-uri, @query and @request-target, default port omitted', () => {
    const sig = parseMessageSignature(
      'sig1=("@target-uri" "@query" "@request-target" "@scheme");created=1;keyid="k"',
      'sig1=:dGVzdA==:',
    )
    if ('error' in sig) throw new Error(sig.error)
    expect(signatureBase(sig, { method: 'GET', scheme: 'https', target: '/users/a?page=1', headers: { host: 'Harmony.Test:443' } }))
      .toBe([
        '"@target-uri": https://harmony.test/users/a?page=1',
        '"@query": ?page=1',
        '"@request-target": /users/a?page=1',
        '"@scheme": https',
        '"@signature-params": ("@target-uri" "@query" "@request-target" "@scheme");created=1;keyid="k"',
      ].join('\n'))
  })

  it('fails when a covered header is absent', () => {
    const sig = parseMessageSignature('sig1=("@method" "date");created=1;keyid="k"', 'sig1=:dGVzdA==:')
    if ('error' in sig) throw new Error(sig.error)
    expect(signatureBase(sig, { method: 'GET', scheme: 'https', target: '/', headers: { host: 'a.test' } }))
      .toEqual({ error: 'Covered component date is absent' })
  })
})

describe('parseMessageSignature', () => {
  it('picks the label that Signature carries and serializes its parameters canonically', () => {
    const sig = parseMessageSignature(
      'other=("@method");created=2;keyid="x", sig1=( "@method"  "@target-uri" );keyid="https://a.test/u#main-key";created=1700000000;alg="rsa-v1_5-sha256"',
      'sig1=:AAEC:',
    )
    expect(sig).toMatchObject({
      label: 'sig1',
      components: ['@method', '@target-uri'],
      keyId: 'https://a.test/u#main-key',
      created: 1700000000,
      alg: 'rsa-v1_5-sha256',
      signatureParams: '("@method" "@target-uri");keyid="https://a.test/u#main-key";created=1700000000;alg="rsa-v1_5-sha256"',
    })
  })

  it.each([
    ['sig1=("@method";req);created=1;keyid="k"', 'Component parameters are not supported'],
    ['sig1=("@method" "@method");created=1;keyid="k"', 'covered twice'],
    ['sig1=("@method");created=1', 'keyid missing'],
    ['sig1=("@method");keyid="k"', 'created missing'],
    ['sig1=("Host");created=1;keyid="k"', 'not lowercase'],
    ['sig1="@method"', 'not an inner list'],
    ['sig1=("@method";created=1', 'Unparseable'],
  ])('refuses %s', (input, error) => {
    const sig = parseMessageSignature(input, 'sig1=:AAEC:')
    expect('error' in sig && sig.error).toContain(error)
  })

  it('reads Structured Field dictionaries with byte sequences and parameters', () => {
    const d = parseSfDictionary('a=:AAEC:, b=("x" "y");n=5, c, d=?0;t')!
    expect(Buffer.from(d.get('a')!.value as Uint8Array)).toEqual(Buffer.from([0, 1, 2]))
    expect(d.get('c')!.value).toBe(true)
    expect(d.get('d')!.value).toBe(false)
    expect(parseSfDictionary('a=1,')).toBeNull()
  })
})

describe('coversRequest', () => {
  const covering = (...components: string[]) => {
    const sig = parseMessageSignature(`s=(${components.map((c) => `"${c}"`).join(' ')});created=1;keyid="k"`, 's=:AAEC:')
    if ('error' in sig) throw new Error(sig.error)
    return sig
  }
  it('requires @method and the target', () => {
    expect(coversRequest(covering('@method', '@target-uri'), '/inbox')).toBe(true)
    expect(coversRequest(covering('@method', '@authority', '@request-target'), '/inbox?x=1')).toBe(true)
    expect(coversRequest(covering('@method', '@authority', '@path'), '/inbox')).toBe(true)
    expect(coversRequest(covering('@method', '@authority', '@path'), '/inbox?x=1')).toBe(false)
    expect(coversRequest(covering('@method', '@authority', '@path', '@query'), '/inbox?x=1')).toBe(true)
    expect(coversRequest(covering('@target-uri'), '/inbox')).toBe(false)
    expect(coversRequest(covering('@method', '@path'), '/inbox')).toBe(false)
  })
})

describe('contentDigestMatches', () => {
  const body = '{"hello": "world"}'
  it('checks RFC 9530 sha-256 and sha-512 values', () => {
    expect(contentDigestMatches('sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:', body)).toBe(true)
    expect(contentDigestMatches('sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:', Buffer.from(body))).toBe(true)
  })
  it('refuses a mismatch, an unknown algorithm alone, and garbage', () => {
    expect(contentDigestMatches('sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:', '{"hello":"world"}')).toBe(false)
    expect(contentDigestMatches('sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:, sha-512=:AAAA:', body)).toBe(false)
    expect(contentDigestMatches('md5=:AAAA:', body)).toBe(false)
    expect(contentDigestMatches('SHA-256=X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=', body)).toBe(false)
  })
})

describe('SignatureService.verifySignature with Signature-Input', () => {
  const ACTOR = 'https://fedify.test/users/alice'
  let pair: { publicKey: string; privateKey: string }

  beforeEach(async () => {
    __publicKeyCache.clear()
    pair = await SignatureService.generateKeyPair()
    vi.mocked(getSupabaseClient).mockReturnValue({
      from: () => {
        const q: any = {}
        for (const m of ['select', 'eq', 'update', 'upsert']) q[m] = () => q
        q.maybeSingle = async () => ({ data: { public_key: pair.publicKey }, error: null })
        return q
      },
    } as any)
  })

  /** An RFC 9421 request as Mastodon 4.7 signs a delivery. */
  function sign(opts: {
    method?: string
    target?: string
    body?: string
    components?: string[]
    created?: number
    alg?: string | null
    tamper?: (h: Record<string, string>) => void
  } = {}) {
    const method = opts.method ?? 'POST'
    const target = opts.target ?? '/users/bob/inbox'
    const headers: Record<string, string> = { host: 'harmony.test' }
    if (opts.body !== undefined) {
      headers['content-digest'] = `sha-256=:${crypto.createHash('sha256').update(opts.body).digest('base64')}:`
    }
    const components = opts.components ?? (opts.body !== undefined ? ['@method', '@target-uri', 'content-digest'] : ['@method', '@target-uri'])
    const created = opts.created ?? Math.floor(Date.now() / 1000)
    const alg = opts.alg === undefined ? 'rsa-v1_5-sha256' : opts.alg
    const params = `(${components.map((c) => `"${c}"`).join(' ')});created=${created};keyid="${ACTOR}#main-key"${alg ? `;alg="${alg}"` : ''}`
    const values: Record<string, string> = {
      '@method': method,
      '@target-uri': `https://harmony.test${target}`,
      '@authority': 'harmony.test',
      '@path': target.split('?')[0],
    }
    const base = [...components.map((c) => `"${c}": ${values[c] ?? headers[c]}`), `"@signature-params": ${params}`].join('\n')
    const signature = crypto.sign('sha256', Buffer.from(base), { key: pair.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING })
    headers['signature-input'] = `sig1=${params}`
    headers.signature = `sig1=:${signature.toString('base64')}:`
    opts.tamper?.(headers)
    return { method, target, headers, body: opts.body }
  }

  const verify = (r: ReturnType<typeof sign>, scheme = 'https') =>
    SignatureService.verifySignature(r.headers.signature, r.headers, r.method, r.target,
      r.body === undefined ? undefined : Buffer.from(r.body), scheme)

  it('verifies a signed delivery and names the key owner', async () => {
    await expect(verify(sign({ body: '{"type":"Follow"}' }))).resolves.toEqual({ verified: true, actorUrl: ACTOR })
  })

  it('verifies a signed GET without alg', async () => {
    await expect(verify(sign({ method: 'GET', target: '/users/bob/outbox?page=1', alg: null })))
      .resolves.toMatchObject({ verified: true, actorUrl: ACTOR })
  })

  it('refuses a body that differs from the digest', async () => {
    const r = sign({ body: '{"type":"Follow"}' })
    r.body = '{"type":"Delete"}'
    await expect(verify(r)).resolves.toMatchObject({ verified: false, error: expect.stringContaining('Content-Digest mismatch') })
  })

  it('refuses a body whose digest the signature does not cover', async () => {
    const r = sign({ body: '{"type":"Follow"}', components: ['@method', '@target-uri'] })
    await expect(verify(r)).resolves.toMatchObject({ verified: false, error: expect.stringContaining('not covered') })
  })

  it('refuses a signature that leaves out the target', async () => {
    await expect(verify(sign({ method: 'GET', components: ['@method', '@authority'] })))
      .resolves.toMatchObject({ verified: false, error: expect.stringContaining('method and target') })
  })

  it('refuses a stale created', async () => {
    await expect(verify(sign({ body: '{}', created: Math.floor(Date.now() / 1000) - 600 })))
      .resolves.toMatchObject({ verified: false, error: expect.stringContaining('clock skew') })
  })

  it('refuses another algorithm', async () => {
    await expect(verify(sign({ body: '{}', alg: 'rsa-pss-sha512' })))
      .resolves.toMatchObject({ verified: false, error: expect.stringContaining('Unsupported signature algorithm') })
  })

  it('refuses a request replayed to another path or by another method', async () => {
    const r = sign({ body: '{}' })
    await expect(verify({ ...r, target: '/inbox' })).resolves.toMatchObject({ verified: false })
    await expect(verify({ ...r, method: 'PUT' })).resolves.toMatchObject({ verified: false })
  })

  it('binds the scheme the request arrived by', async () => {
    await expect(verify(sign({ method: 'GET' }), 'http')).resolves.toMatchObject({ verified: false })
  })

  it('refuses a signature by another key', async () => {
    const r = sign({ body: '{}' })
    pair = await SignatureService.generateKeyPair()
    __publicKeyCache.clear()
    await expect(verify(r)).resolves.toMatchObject({ verified: false, error: 'Signature does not verify' })
  })
})
