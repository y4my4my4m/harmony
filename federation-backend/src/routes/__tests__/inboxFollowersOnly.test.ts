import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// Personal-inbox addressing of followers-only posts. GoToSocial delivers to
// each follower's personal inbox, addressing only its followers collection.

vi.mock('../../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', REQUIRE_VALID_SIGNATURES: true },
}))
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
}))
vi.mock('../../middleware/rateLimit.js', () => ({
  inboxLimiter: (_req: any, _res: any, next: any) => next(),
  instanceInboxLimit: async () => true,
  signerInstanceKey: () => 'test',
  clientIp: () => '203.0.113.1',
}))
vi.mock('../../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: () => false },
}))
vi.mock('../../services/FederatedInstanceService.js', () => ({
  FederatedInstanceService: { touchFromUrl: vi.fn() },
}))
vi.mock('../../activitypub/SignatureService.js', () => ({
  SignatureService: {
    verifySignature: vi.fn(async () => ({ verified: true, actorUrl: 'https://gts.test/users/alice' })),
    verifyActorMatch: vi.fn(() => true),
  },
}))
const processIncomingActivity = vi.fn(async () => undefined)
vi.mock('../../activitypub/ActivityProcessor.js', () => ({
  ActivityProcessor: { processIncomingActivity },
}))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}

vi.mock('../../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string) => Promise.resolve({ data: fn === 'claim_ap_activity' ? true : null, error: null }),
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = []
      const first = () => (tables[table] ?? []).find((r) => filters.every((f) => f(r))) ?? null
      const c: any = {
        select: () => c,
        eq: (col: string, v: any) => { filters.push((r) => r[col] === v); return c },
        single: () => Promise.resolve({ data: first(), error: null }),
        maybeSingle: () => Promise.resolve({ data: first(), error: null }),
      }
      return c
    },
  }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const { default: inboxRouter } = await import('../../activitypub/InboxHandler.js')

function app() {
  const a = express()
  a.use(express.json({ type: ['application/json', 'application/activity+json'] }))
  a.use('/', inboxRouter)
  return a
}

const ALICE = 'https://gts.test/users/alice'
const followersOnlyCreate = {
  id: 'https://gts.test/users/alice/statuses/1/activity',
  type: 'Create',
  actor: ALICE,
  to: [`${ALICE}/followers`],
  cc: [],
  object: { id: 'https://gts.test/users/alice/statuses/1', type: 'Note', content: 'followers only', to: [`${ALICE}/followers`] },
}

beforeEach(() => {
  processIncomingActivity.mockClear()
  tables = {
    profiles: [
      { id: 'bob-id', username: 'bob', is_local: true, federated_id: 'https://harmony.test/users/bob' },
      { id: 'alice-id', username: 'alice', is_local: false, federated_id: ALICE, followers_url: `${ALICE}/followers` },
    ],
    follows: [],
  }
})

const post = () =>
  supertest(app())
    .post('/users/bob/inbox')
    .set('Content-Type', 'application/activity+json')
    .set('Signature', `keyId="${ALICE}/main-key",signature="x"`)
    .send(followersOnlyCreate)

describe('personal inbox, followers-only post', () => {
  it('processes it when the recipient follows the sender', async () => {
    tables.follows.push({ id: 'f1', follower_id: 'bob-id', following_id: 'alice-id', status: 'accepted' })

    const res = await post()

    expect(res.status).toBe(202)
    expect(processIncomingActivity).toHaveBeenCalledTimes(1)
  })

  it('ignores it when the recipient does not follow the sender', async () => {
    const res = await post()

    expect(res.status).toBe(202)
    expect(res.body.status).toBe('ignored')
    expect(processIncomingActivity).not.toHaveBeenCalled()
  })

  it('ignores it while the follow is still pending', async () => {
    tables.follows.push({ id: 'f1', follower_id: 'bob-id', following_id: 'alice-id', status: 'pending' })

    await post()

    expect(processIncomingActivity).not.toHaveBeenCalled()
  })
})
