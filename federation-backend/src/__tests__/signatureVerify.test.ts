import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import crypto from 'crypto'

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}

// Table-keyed Supabase double: .from(t).select().eq(col, v).maybeSingle(),
// plus the no-op writes fetchActorPublicKey performs after a remote fetch.
function fakeSupabase() {
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      const builder: any = {
        select() { return builder },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        update() { return builder },
        upsert() { return Promise.resolve({ data: null, error: null }) },
        maybeSingle() {
          const row = (tables[table] ?? []).find((r) => filters.every((f) => f(r)))
          return Promise.resolve({ data: row ?? null, error: null })
        },
        then(resolve: any) { return resolve({ data: null, error: null }) },
      }
      return builder
    },
  }
}

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => fakeSupabase() }))
vi.mock('../middleware/errorHandler.js', () => ({ AppError: class extends Error {} }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../utils/ssrfProtection.js', () => ({ safeFetch: vi.fn() }))
vi.mock('../activitypub/InstanceActor.js', () => ({
  signAsInstanceActor: vi.fn(async (url: string) => ({
    headers: { Host: new URL(url).host, Date: new Date().toUTCString(), Signature: 'keyId="https://harmony.test/users/instance.actor#main-key"' },
  })),
}))

import { SignatureService, __publicKeyCache } from '../activitypub/SignatureService.js'
import { safeFetch } from '../utils/ssrfProtection.js'

const INBOX_PATH = '/users/bob/inbox'
const HOST = 'harmony.test'

let keys: { publicKey: string; privateKey: string }

beforeAll(async () => {
  keys = await SignatureService.generateKeyPair()
})

beforeEach(() => {
  vi.mocked(safeFetch).mockReset()
  __publicKeyCache.clear()
  tables = { profiles: [], ap_actor_cache: [] }
})

function sign(keyId: string, headerNames: string[], values: Record<string, string>) {
  const signingString = headerNames
    .map((h) => (h === '(request-target)' ? `(request-target): post ${INBOX_PATH}` : `${h}: ${values[h]}`))
    .join('\n')
  const signature = crypto.createSign('SHA256').update(signingString).sign(keys.privateKey, 'base64')
  return `keyId="${keyId}",algorithm="rsa-sha256",headers="${headerNames.join(' ')}",signature="${signature}"`
}

function request(keyId: string, headerNames: string[], opts: { omitDate?: boolean } = {}) {
  const body = JSON.stringify({ type: 'Like', actor: 'https://remote.test/users/alice' })
  const values: Record<string, string> = {
    host: HOST,
    date: new Date().toUTCString(),
    digest: SignatureService.createDigest(body),
  }
  const headers: Record<string, string> = { host: values.host, digest: values.digest }
  if (!opts.omitDate) headers.date = values.date
  return { signature: sign(keyId, headerNames, values), headers, body }
}

const verify = (r: ReturnType<typeof request>) =>
  SignatureService.verifySignature(r.signature, r.headers, 'POST', INBOX_PATH, Buffer.from(r.body))

const json = (doc: unknown) =>
  new Response(JSON.stringify(doc), { status: 200, headers: { 'Content-Type': 'application/activity+json' } })

describe('verifySignature', () => {
  it('verifies a Mastodon-style signature with a #main-key keyId', async () => {
    tables.profiles.push({ federated_id: 'https://remote.test/users/alice', public_key: keys.publicKey })
    const r = request('https://remote.test/users/alice#main-key', ['(request-target)', 'host', 'date', 'digest'])

    const result = await verify(r)

    expect(result).toMatchObject({ verified: true, actorUrl: 'https://remote.test/users/alice' })
  })

  it('rejects a signature that does not cover Date', async () => {
    tables.profiles.push({ federated_id: 'https://remote.test/users/alice', public_key: keys.publicKey })
    const r = request('https://remote.test/users/alice#main-key', ['(request-target)', 'host', 'digest'])

    const result = await verify(r)

    expect(result.verified).toBe(false)
    expect(result.error).toMatch(/Date/)
  })

  it('rejects a request without a Date header', async () => {
    tables.profiles.push({ federated_id: 'https://remote.test/users/alice', public_key: keys.publicKey })
    const r = request('https://remote.test/users/alice#main-key', ['(request-target)', 'host', 'digest'], {
      omitDate: true,
    })

    const result = await verify(r)

    expect(result.verified).toBe(false)
  })

  it('resolves a GoToSocial <actor>/main-key keyId to the actor', async () => {
    const actor = 'https://gts.test/users/alice'
    const keyId = `${actor}/main-key`
    const publicKey = { id: keyId, owner: actor, publicKeyPem: keys.publicKey }
    vi.mocked(safeFetch).mockImplementation(async (url: any) => {
      if (url === keyId) return json({ id: actor, type: 'Person', preferredUsername: 'alice', publicKey })
      if (url === actor) return json({ id: actor, type: 'Person', inbox: `${actor}/inbox`, publicKey })
      return new Response('', { status: 404 })
    })
    const r = request(keyId, ['(request-target)', 'host', 'date', 'digest'])

    const result = await verify(r)

    expect(result).toMatchObject({ verified: true, actorUrl: actor })
    // GoToSocial serves nothing to an unsigned GET; the key and actor fetches are signed.
    for (const [, init] of vi.mocked(safeFetch).mock.calls) {
      expect((init as any).headers.Signature).toContain('instance.actor#main-key')
    }
  })

  it('rejects a keyId whose document names an owner on another host', async () => {
    const keyId = 'https://evil.test/keys/1'
    vi.mocked(safeFetch).mockImplementation(async (url: any) => {
      if (url === keyId) {
        return json({
          id: 'https://remote.test/users/alice',
          type: 'Person',
          publicKey: { id: keyId, owner: 'https://remote.test/users/alice', publicKeyPem: keys.publicKey },
        })
      }
      return new Response('', { status: 404 })
    })
    const r = request(keyId, ['(request-target)', 'host', 'date', 'digest'])

    const result = await verify(r)

    expect(result.verified).toBe(false)
    expect(result.actorUrl).toBeUndefined()
  })
})

describe('actor document used for the key', () => {
  const BOB = 'https://remote.test/users/bob'
  const UPLOAD = 'https://remote.test/uploads/evil.json'

  it('is refused when the document at the key owner names another actor', async () => {
    vi.mocked(safeFetch).mockImplementation(async (url: any) => {
      if (url === UPLOAD) {
        return json({ id: BOB, type: 'Person', publicKey: { id: `${BOB}#main-key`, owner: BOB, publicKeyPem: keys.publicKey } })
      }
      return new Response('', { status: 404 })
    })
    const result = await verify(request(`${UPLOAD}#main-key`, ['(request-target)', 'host', 'date', 'digest']))
    expect(result.verified).toBe(false)
  })

  it('is refused when it is not served as ActivityPub', async () => {
    vi.mocked(safeFetch).mockImplementation(async (url: any) => {
      if (url === UPLOAD) {
        return new Response(JSON.stringify({
          id: UPLOAD, type: 'Person', publicKey: { id: `${UPLOAD}#main-key`, owner: UPLOAD, publicKeyPem: keys.publicKey },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('', { status: 404 })
    })
    const result = await verify(request(`${UPLOAD}#main-key`, ['(request-target)', 'host', 'date', 'digest']))
    expect(result.verified).toBe(false)
  })

  it('is refused when its key names another owner', async () => {
    vi.mocked(safeFetch).mockImplementation(async (url: any) => {
      if (url === BOB) {
        return json({ id: BOB, type: 'Person', publicKey: { id: `${BOB}#main-key`, owner: 'https://remote.test/users/alice', publicKeyPem: keys.publicKey } })
      }
      return new Response('', { status: 404 })
    })
    const result = await verify(request(`${BOB}#main-key`, ['(request-target)', 'host', 'date', 'digest']))
    expect(result.verified).toBe(false)
  })

  it('is refused when the fetch was redirected away from the actor id', async () => {
    vi.mocked(safeFetch).mockImplementation(async (url: any) => {
      if (url === BOB) {
        const res = json({ id: BOB, type: 'Person', publicKey: { id: `${BOB}#main-key`, owner: BOB, publicKeyPem: keys.publicKey } })
        Object.defineProperty(res, 'url', { value: UPLOAD })
        return res
      }
      return new Response('', { status: 404 })
    })
    const result = await verify(request(`${BOB}#main-key`, ['(request-target)', 'host', 'date', 'digest']))
    expect(result.verified).toBe(false)
  })

  it('is used when served from its own id with a key it owns', async () => {
    vi.mocked(safeFetch).mockImplementation(async (url: any) => {
      if (url === BOB) {
        return json({ id: BOB, type: 'Person', publicKey: { id: `${BOB}#main-key`, owner: BOB, publicKeyPem: keys.publicKey } })
      }
      return new Response('', { status: 404 })
    })
    const result = await verify(request(`${BOB}#main-key`, ['(request-target)', 'host', 'date', 'digest']))
    expect(result).toMatchObject({ verified: true, actorUrl: BOB })
  })
})
