import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'

// Inbound Flag: the inbox demands a verified signature for Flag even when
// REQUIRE_VALID_SIGNATURES is off, rejects blocked domains, names id-less Flags
// stably; ActivityProcessor.processFlag maps object URIs to local accounts and
// their own posts and files one report per account through
// create_federated_report.

const config = vi.hoisted(() => ({
  INSTANCE_DOMAIN: 'harmony.test',
  INSTANCE_NAME: 'Harmony Test',
  NODE_ENV: 'test',
  REQUIRE_VALID_SIGNATURES: false,
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
  result: { verified: true, actorUrl: 'https://remote.test/actor' } as { verified: boolean; actorUrl?: string; error?: string },
}))
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: {
    verifySignature: vi.fn(async () => verification.result),
    verifyActorMatch: (a: string, b: string) => a === b,
  },
}))

const ALICE = '11111111-0000-0000-0000-000000000001'
const BOB = '22222222-0000-0000-0000-000000000002'
const ALICE_POST = '33333333-0000-0000-0000-000000000003'
const BOB_POST = '44444444-0000-0000-0000-000000000004'

const profilesByUsername: Record<string, { id: string }> = { alice: { id: ALICE }, bob: { id: BOB } }
const profilesByFederatedId: Record<string, { id: string }> = {
  'https://harmony.test/@alice/legacy': { id: ALICE },
}
const postsById: Record<string, { id: string; author_id: string }> = {
  [ALICE_POST]: { id: ALICE_POST, author_id: ALICE },
  [BOB_POST]: { id: BOB_POST, author_id: BOB },
}

const rpcCalls: Array<{ name: string; args: any }> = []
const rpcResults: Record<string, any> = {}

function query(table: string) {
  const f: Record<string, unknown> = {}
  const c: any = {
    select: () => c,
    eq: (col: string, val: unknown) => { f[col] = val; return c },
    ilike: (col: string, val: string) => { f[`ilike:${col}`] = val.replace(/\\_/g, '_'); return c },
    single: () => c.maybeSingle(),
    maybeSingle: () => {
      let data: any = null
      if (table === 'profiles') {
        if (f['ilike:username']) data = profilesByUsername[String(f['ilike:username']).toLowerCase()] ?? null
        else if (f.username) data = profilesByUsername[String(f.username)] ?? null
        else if (f.federated_id) data = profilesByFederatedId[String(f.federated_id)] ?? null
      } else if (table === 'posts') {
        if (f.id) data = postsById[String(f.id)] ?? null
      }
      return Promise.resolve({ data, error: null })
    },
  }
  return c
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: (t: string) => query(t),
    rpc: (name: string, args: any) => {
      rpcCalls.push({ name, args })
      return Promise.resolve({ data: rpcResults[name] ?? { status: 'created' }, error: null })
    },
  }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js')
const { default: inboxRouter } = await import('../activitypub/InboxHandler.js')
const { syntheticFlagId, flagObjectUris, parseLocalObjectUri, flagComment } = await import('../activitypub/flag.js')
const { default: supertest } = await import('supertest')

function app() {
  const a = express()
  a.use(express.json({
    type: ['application/json', 'application/activity+json'],
    verify: (req: any, _res, buf) => { req.rawBody = buf },
  }))
  a.use('/', inboxRouter)
  return a
}

function reportCalls() {
  return rpcCalls.filter((c) => c.name === 'create_federated_report').map((c) => c.args)
}

beforeEach(() => {
  rpcCalls.length = 0
  for (const k of Object.keys(rpcResults)) delete rpcResults[k]
  blocked.clear()
  config.REQUIRE_VALID_SIGNATURES = false
  verification.result = { verified: true, actorUrl: 'https://remote.test/actor' }
})

describe('flag helpers', () => {
  it('reads object URIs from strings and objects, once each', () => {
    expect(flagObjectUris(['https://a/1', { id: 'https://a/2' }, 'https://a/1', 7, null])).toEqual(['https://a/1', 'https://a/2'])
    expect(flagObjectUris('https://a/1')).toEqual(['https://a/1'])
    expect(flagObjectUris(undefined)).toEqual([])
  })

  it('recognises local account and post URIs only', () => {
    expect(parseLocalObjectUri('https://harmony.test/users/alice', 'harmony.test')).toEqual({ kind: 'account', username: 'alice' })
    expect(parseLocalObjectUri('https://harmony.test/@alice', 'harmony.test')).toEqual({ kind: 'account', username: 'alice' })
    expect(parseLocalObjectUri(`https://harmony.test/posts/${ALICE_POST}`, 'harmony.test')).toEqual({ kind: 'post', id: ALICE_POST })
    expect(parseLocalObjectUri('https://evil.test/users/alice', 'harmony.test')).toBeNull()
    expect(parseLocalObjectUri('https://harmony.test/users/al%25ice', 'harmony.test')).toBeNull()
    expect(parseLocalObjectUri('https://harmony.test/posts/not-a-uuid', 'harmony.test')).toBeNull()
  })

  it('keeps comments as bounded plain text', () => {
    expect(flagComment('<p>spam &amp; scam</p><p>again</p>')).toBe('spam & scam\n\nagain')
    expect(flagComment(42)).toBe('')
    expect(flagComment('x'.repeat(5000))).toHaveLength(1000)
  })

  it('names an id-less Flag by actor and body', () => {
    const a = syntheticFlagId('https://remote.test/actor', '{"type":"Flag"}')
    expect(a).toBe(syntheticFlagId('https://remote.test/actor', '{"type":"Flag"}'))
    expect(a).not.toBe(syntheticFlagId('https://remote.test/actor', '{"type":"Flag","content":"x"}'))
    expect(a.startsWith('https://remote.test/actor#flag-')).toBe(true)
  })
})

describe('ActivityProcessor.processFlag', () => {
  it('files one report per local account with only that account\'s posts', async () => {
    await ActivityProcessor.processFlag({
      id: 'https://remote.test/flags/1',
      type: 'Flag',
      actor: 'https://remote.test/actor',
      content: 'Spam',
      object: [
        'https://harmony.test/users/alice',
        `https://harmony.test/posts/${ALICE_POST}`,
        `https://harmony.test/posts/${BOB_POST}`,
        'https://remote.test/notes/9',
        'https://harmony.test/users/nobody',
      ],
    })

    expect(reportCalls()).toEqual([{
      p_ap_id: 'https://remote.test/flags/1',
      p_actor: 'https://remote.test/actor',
      p_source_domain: 'remote.test',
      p_reported_user_id: ALICE,
      p_post_ids: [ALICE_POST],
      p_comment: 'Spam',
      p_object_uris: [
        'https://harmony.test/users/alice',
        `https://harmony.test/posts/${ALICE_POST}`,
        `https://harmony.test/posts/${BOB_POST}`,
        'https://remote.test/notes/9',
        'https://harmony.test/users/nobody',
      ],
    }])
  })

  it('files a report for each named account', async () => {
    await ActivityProcessor.processFlag({
      id: 'https://remote.test/flags/2',
      type: 'Flag',
      actor: 'https://remote.test/actor',
      object: ['https://harmony.test/users/alice', 'https://harmony.test/users/bob'],
    })
    expect(reportCalls().map((c) => c.p_reported_user_id)).toEqual([ALICE, BOB])
    expect(reportCalls().every((c) => c.p_comment === '')).toBe(true)
  })

  it('resolves a local account by its stored actor id', async () => {
    await ActivityProcessor.processFlag({
      id: 'https://remote.test/flags/3',
      type: 'Flag',
      actor: 'https://remote.test/actor',
      object: 'https://harmony.test/@alice/legacy',
    })
    expect(reportCalls().map((c) => c.p_reported_user_id)).toEqual([ALICE])
  })

  it('attributes a statuses-only Flag to the statuses\' authors', async () => {
    await ActivityProcessor.processFlag({
      id: 'https://lemmy.test/report/1',
      type: 'Flag',
      actor: 'https://lemmy.test/u/mod',
      object: { id: `https://harmony.test/posts/${BOB_POST}`, type: 'Note' },
    })
    expect(reportCalls()).toEqual([expect.objectContaining({
      p_reported_user_id: BOB, p_post_ids: [BOB_POST], p_source_domain: 'lemmy.test',
    })])
  })

  it('ignores a Flag that names nothing local', async () => {
    await ActivityProcessor.processFlag({
      id: 'https://remote.test/flags/4',
      type: 'Flag',
      actor: 'https://remote.test/actor',
      object: ['https://remote.test/users/x', 'https://harmony.test/users/nobody', 'not a url'],
    })
    expect(reportCalls()).toEqual([])
  })
})

describe('inbox: Flag', () => {
  const flag = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: 'https://remote.test/flags/10',
    type: 'Flag',
    actor: 'https://remote.test/actor',
    object: ['https://harmony.test/users/alice'],
    content: 'Harassment',
  }

  function post(body: unknown, signed = true, path = '/inbox') {
    const req = supertest(app()).post(path).set('Content-Type', 'application/activity+json')
    if (signed) req.set('Signature', 'keyId="https://remote.test/actor#main-key",headers="(request-target)",signature="x"')
    return req.send(body as object)
  }

  it('refuses an unsigned Flag even with REQUIRE_VALID_SIGNATURES off', async () => {
    const res = await post(flag, false)
    expect(res.status).toBe(401)
    expect(reportCalls()).toEqual([])
  })

  it('refuses a Flag whose signature does not verify', async () => {
    verification.result = { verified: false, error: 'bad signature' }
    const res = await post(flag)
    expect(res.status).toBe(401)
    expect(reportCalls()).toEqual([])
  })

  it('refuses a Flag signed by another actor', async () => {
    verification.result = { verified: true, actorUrl: 'https://remote.test/users/someone' }
    const res = await post(flag)
    expect(res.status).toBe(403)
    expect(reportCalls()).toEqual([])
  })

  it('refuses a Flag from a blocked domain', async () => {
    blocked.add('remote.test')
    const res = await post(flag)
    expect(res.status).toBe(403)
    expect(reportCalls()).toEqual([])
  })

  it('accepts a signed Flag and files the report', async () => {
    rpcResults.claim_ap_activity = true
    const res = await post(flag)
    expect(res.status).toBe(202)
    expect(reportCalls()).toEqual([expect.objectContaining({
      p_ap_id: 'https://remote.test/flags/10', p_reported_user_id: ALICE, p_comment: 'Harassment',
    })])
  })

  it('accepts a Flag delivered to the reported account\'s personal inbox, as Mastodon and Misskey send it', async () => {
    rpcResults.claim_ap_activity = true
    const res = await post(flag, true, '/users/alice/inbox')
    expect(res.status).toBe(202)
    expect(res.body.message).toBe('Activity accepted')
    expect(reportCalls()).toEqual([expect.objectContaining({ p_reported_user_id: ALICE })])
  })

  it('accepts a Flag at the instance actor inbox as the shared inbox', async () => {
    rpcResults.claim_ap_activity = true
    const res = await post(flag, true, '/users/instance.actor/inbox')
    expect(res.status).toBe(202)
    expect(reportCalls()).toHaveLength(1)
  })

  it('stores a redelivered Flag once: the claim guard refuses the second', async () => {
    rpcResults.claim_ap_activity = false
    const res = await post(flag)
    expect(res.status).toBe(202)
    expect(res.body.message).toBe('Activity already processed')
    expect(reportCalls()).toEqual([])
  })

  it('gives an id-less Flag a stable id derived from its body', async () => {
    rpcResults.claim_ap_activity = true
    const { id: _omit, ...idless } = flag
    await post(idless)
    await post(idless)
    const stored = rpcCalls.filter((c) => c.name === 'upsert_ap_activity').map((c) => c.args.p_ap_id)
    expect(stored).toHaveLength(2)
    expect(stored[0]).toMatch(/^https:\/\/remote\.test\/actor#flag-[0-9a-f]{64}$/)
    expect(stored[1]).toBe(stored[0])
    expect(reportCalls()[0].p_ap_id).toBe(stored[0])
  })
})
