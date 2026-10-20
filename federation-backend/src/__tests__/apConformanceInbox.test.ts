import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'

// The shared inbox: an activity type it does not implement is acknowledged and dropped
// before anything is stored; a Delete of an actor whose key is gone is acknowledged; an
// activity forwarded by another signer is processed only as its origin serves it.

const config = vi.hoisted(() => ({
  INSTANCE_DOMAIN: 'harmony.test',
  INSTANCE_NAME: 'Harmony Test',
  NODE_ENV: 'test',
  REQUIRE_VALID_SIGNATURES: true,
}))
vi.mock('../config/index.js', () => ({ default: config }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
  AppError: class extends Error {},
}))
const blocked = vi.hoisted(() => new Set<string>())
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: (d: string) => blocked.has(d) },
}))
vi.mock('../services/FederatedInstanceService.js', () => ({
  FederatedInstanceService: { touchFromUrl: vi.fn() },
}))

const verification = vi.hoisted(() => ({
  result: { verified: true, actorUrl: 'https://origin.test/users/ann' } as Record<string, unknown>,
}))
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: {
    verifySignature: vi.fn(async () => verification.result),
    verifyActorMatch: (a: string, b: string) => a === b,
  },
}))

const processor = vi.hoisted(() => ({
  processed: [] as any[],
  docs: new Map<string, { status: number; doc?: any }>(),
}))
vi.mock('../activitypub/ActivityProcessor.js', () => ({
  ActivityProcessor: {
    processIncomingActivity: vi.fn(async (activity: any) => { processor.processed.push(activity) }),
    fetchApDocument: vi.fn(async (url: string, onStatus?: (s: number) => void) => {
      const hit = processor.docs.get(url) ?? { status: 404 }
      onStatus?.(hit.status)
      return hit.status === 200 ? { doc: hit.doc, finalUrl: url } : null
    }),
  },
}))

const rpcCalls: string[] = []
const storedPosts = new Map<string, string>()
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: () => {
      const f: Record<string, unknown> = {}
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { f[c] = v; return q },
        maybeSingle: async () => ({ data: storedPosts.has(String(f.ap_id)) ? { visibility: storedPosts.get(String(f.ap_id)) } : null, error: null }),
      }
      return q
    },
    rpc: async (name: string) => {
      rpcCalls.push(name)
      return { data: name === 'claim_ap_activity' ? true : null, error: null }
    },
  }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const { default: inboxRouter } = await import('../activitypub/InboxHandler.js')
const { default: supertest } = await import('supertest')

function app() {
  const a = express()
  a.use(express.json({ type: ['application/json', 'application/activity+json'], verify: (req: any, _res, buf) => { req.rawBody = buf } }))
  a.use('/', inboxRouter)
  return a
}
const deliver = (activity: unknown, signed = true) => {
  const req = supertest(app()).post('/inbox').set('Content-Type', 'application/activity+json')
  return (signed ? req.set('Signature', 'keyId="x",headers="(request-target) host date digest",signature="s"') : req).send(activity as object)
}

const ANN = 'https://origin.test/users/ann'
const NOTE = 'https://origin.test/users/ann/statuses/1'

beforeEach(() => {
  rpcCalls.length = 0
  processor.processed.length = 0
  processor.docs.clear()
  storedPosts.clear()
  blocked.clear()
  config.REQUIRE_VALID_SIGNATURES = true
  verification.result = { verified: true, actorUrl: ANN }
})

describe('activity types the inbox does not implement', () => {
  it.each(['View', 'LikeRequest', 'ReplyRequest', 'Dislike', 'ChatMessage'])('%s is answered 202 ignored and stored nowhere', async (type) => {
    const res = await deliver({ id: `${ANN}/a/1`, type, actor: ANN, object: NOTE })
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ status: 'ignored', reason: 'unsupported activity type' })
    expect(rpcCalls).toEqual([])
    expect(processor.processed).toEqual([])
  })

  it('still needs a signature', async () => {
    expect((await deliver({ id: `${ANN}/a/1`, type: 'View', actor: ANN, object: NOTE }, false)).status).toBe(401)
    verification.result = { verified: false, error: 'bad' }
    expect((await deliver({ id: `${ANN}/a/1`, type: 'View', actor: ANN, object: NOTE })).status).toBe(401)
  })

  it('a supported type is stored and processed', async () => {
    const res = await deliver({ id: `${ANN}/a/2`, type: 'Like', actor: ANN, object: 'https://harmony.test/posts/1' })
    expect(res.status).toBe(202)
    expect(rpcCalls).toContain('upsert_ap_activity')
    expect(processor.processed).toHaveLength(1)
  })
})

describe('Delete of an actor whose key is gone', () => {
  it.each([410, 404])('is acknowledged when the key fetch answers %i', async (status) => {
    verification.result = { verified: false, actorUrl: ANN, error: 'Could not fetch public key', keyStatus: status }
    const res = await deliver({ id: `${ANN}#delete`, type: 'Delete', actor: ANN, object: ANN })
    expect(res.status).toBe(202)
    expect(res.body.status).toBe('ignored')
    expect(rpcCalls).toEqual([])
    expect(processor.processed).toEqual([])
  })

  it('is refused for any other failure, and for a Delete of something else', async () => {
    verification.result = { verified: false, actorUrl: ANN, error: 'Could not fetch public key', keyStatus: 503 }
    expect((await deliver({ id: `${ANN}#delete`, type: 'Delete', actor: ANN, object: ANN })).status).toBe(401)
    verification.result = { verified: false, actorUrl: ANN, error: 'Could not fetch public key', keyStatus: 410 }
    expect((await deliver({ id: `${NOTE}#delete`, type: 'Delete', actor: ANN, object: NOTE })).status).toBe(401)
  })
})

describe('forwarded activities', () => {
  const FORWARDER = 'https://forwarder.test/users/bob'
  const create = { id: `${NOTE}/activity`, type: 'Create', actor: ANN, to: ['https://www.w3.org/ns/activitystreams#Public'],
    object: { id: NOTE, type: 'Note', attributedTo: ANN, content: '<p>forged</p>' } }

  beforeEach(() => {
    verification.result = { verified: true, actorUrl: FORWARDER }
  })

  it('a Create is processed as its origin serves it, and not recorded', async () => {
    processor.docs.set(NOTE, { status: 200, doc: { id: NOTE, type: 'Note', attributedTo: ANN, content: '<p>real</p>' } })
    const res = await deliver(create)
    expect(res.status).toBe(202)
    expect(processor.processed).toHaveLength(1)
    expect(processor.processed[0].object.content).toBe('<p>real</p>')
    expect(rpcCalls).toEqual([])
  })

  it('is refused 403 when the origin does not confirm it', async () => {
    processor.docs.set(NOTE, { status: 200, doc: { id: NOTE, type: 'Note', attributedTo: 'https://origin.test/users/eve' } })
    expect((await deliver(create)).status).toBe(403)
    processor.docs.clear()
    expect((await deliver(create)).status).toBe(403)
    expect(processor.processed).toEqual([])
  })

  it('a Delete of a stored public post is applied once the origin answers 410', async () => {
    storedPosts.set(NOTE, 'public')
    processor.docs.set(NOTE, { status: 410 })
    const res = await deliver({ id: `${NOTE}#delete`, type: 'Delete', actor: ANN, object: { id: NOTE, type: 'Tombstone' } })
    expect(res.status).toBe(202)
    expect(processor.processed).toEqual([{ id: `${NOTE}#delete`, type: 'Delete', actor: ANN, object: NOTE }])
  })

  it('anything else keeps the 403', async () => {
    for (const type of ['Like', 'Follow', 'Undo', 'Block']) {
      expect((await deliver({ id: `${ANN}/x/${type}`, type, actor: ANN, object: NOTE })).status).toBe(403)
    }
    expect(processor.processed).toEqual([])
  })

  it('a Move and a Flag still require their own actor\'s signature', async () => {
    expect((await deliver({ id: `${ANN}/move`, type: 'Move', actor: ANN, object: ANN, target: 'https://new.test/u' })).status).toBe(403)
    expect((await deliver({ id: `${ANN}/flag`, type: 'Flag', actor: ANN, object: ['https://harmony.test/users/alice'] })).status).toBe(403)
  })

  it('a forwarder on a blocked instance is refused', async () => {
    blocked.add('forwarder.test')
    processor.docs.set(NOTE, { status: 200, doc: { id: NOTE, type: 'Note', attributedTo: ANN } })
    expect((await deliver(create)).status).toBe(403)
    expect(processor.processed).toEqual([])
  })
})
