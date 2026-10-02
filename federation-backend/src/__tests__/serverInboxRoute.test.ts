import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// POST /servers/:id/inbox - signer binding and third-party Accept/Reject.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', REQUIRE_VALID_SIGNATURES: true },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
}))
vi.mock('../middleware/rateLimit.js', () => ({
  inboxLimiter: (_req: any, _res: any, next: any) => next(),
  instanceInboxLimit: async () => true,
  signerInstanceKey: () => 'test',
}))
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: () => false },
}))

const SERVER_ID = '00000000-0000-4000-8000-0000000000aa'
const deletes: string[] = []
const updates: string[] = []

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    rpc: () => Promise.resolve({ data: true, error: null }),
    from: (table: string) => {
      const c: any = {
        select: () => c,
        eq: () => c,
        single: () =>
          Promise.resolve(
            table === 'servers'
              ? { data: { id: SERVER_ID, is_local_server: true, federation_enabled: true }, error: null }
              : { data: { id: 'alice-id', username: 'alice' }, error: null },
          ),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        delete: () => { deletes.push(table); return c },
        update: () => { updates.push(table); return c },
        then: (resolve: any) => resolve({ data: null, error: null }),
      }
      return c
    },
  }),
}))

const verifySignature = vi.fn()
vi.mock('../activitypub/SignatureService.js', async () => {
  const actual = await vi.importActual<any>('../activitypub/SignatureService.js')
  return {
    SignatureService: {
      verifySignature: (...args: any[]) => verifySignature(...args),
      verifyActorMatch: actual.SignatureService.verifyActorMatch,
    },
  }
})

const { default: groupRouter } = await import('../activitypub/GroupService.js')

function app() {
  const a = express()
  a.use(express.json({ type: ['application/json', 'application/activity+json'] }))
  a.use('/', groupRouter)
  return a
}

beforeEach(() => {
  deletes.length = 0
  updates.length = 0
  verifySignature.mockReset()
})

describe('server inbox', () => {
  it('rejects an activity whose actor is another user on the signer\'s host', async () => {
    verifySignature.mockResolvedValue({ verified: true, actorUrl: 'https://remote.test/users/mallory' })

    const res = await supertest(app())
      .post(`/servers/${SERVER_ID}/inbox`)
      .set('Content-Type', 'application/activity+json')
      .set('Signature', 'keyId="https://remote.test/users/mallory#main-key",signature="x"')
      .send({
        id: 'https://remote.test/activities/1',
        type: 'Create',
        actor: 'https://remote.test/users/victim',
        object: { id: 'https://remote.test/notes/1', type: 'Note', content: 'impersonated' },
      })

    expect(res.status).toBe(403)
  })

  it('rejects a signed activity with no actor', async () => {
    verifySignature.mockResolvedValue({ verified: true, actorUrl: 'https://remote.test/users/mallory' })

    const res = await supertest(app())
      .post(`/servers/${SERVER_ID}/inbox`)
      .set('Content-Type', 'application/activity+json')
      .set('Signature', 'keyId="https://remote.test/users/mallory#main-key",signature="x"')
      .send({ id: 'https://remote.test/activities/2', type: 'Reject', object: { type: 'Join', actor: 'https://harmony.test/users/alice' } })

    expect(res.status).toBe(403)
    expect(deletes).not.toContain('user_servers')
  })

  it('ignores a third-party Reject of a member\'s Join', async () => {
    verifySignature.mockResolvedValue({ verified: true, actorUrl: 'https://remote.test/users/mallory' })

    const res = await supertest(app())
      .post(`/servers/${SERVER_ID}/inbox`)
      .set('Content-Type', 'application/activity+json')
      .set('Signature', 'keyId="https://remote.test/users/mallory#main-key",signature="x"')
      .send({
        id: 'https://remote.test/activities/3',
        type: 'Reject',
        actor: 'https://remote.test/users/mallory',
        object: { type: 'Join', actor: 'https://harmony.test/users/alice', object: `https://harmony.test/servers/${SERVER_ID}` },
      })

    expect(res.status).toBe(202)
    expect(deletes).not.toContain('user_servers')
    expect(updates).not.toContain('user_servers')
  })
})
