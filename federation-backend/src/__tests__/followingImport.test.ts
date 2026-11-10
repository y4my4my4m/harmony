import { describe, it, expect, vi, beforeEach } from 'vitest'

// The following-import job: how a handle resolves and what the worker tells the database. The
// follow itself is finish_following_import_item (db_schema/tests/251_following_import.sql).

const config = vi.hoisted(() => ({ INSTANCE_DOMAIN: 'harmony.test' }))
vi.mock('../config/index.js', () => ({ default: config, config }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const state = vi.hoisted(() => ({
  blocked: new Set<string>(),
  switches: { inbound: true, outbound: true },
  stored: null as any,
  resolved: { ok: true, user: { id: 'fetched-id' }, actor: {} } as any,
  resolveCalls: [] as string[],
  local: null as any,
  rpc: [] as Array<{ name: string; args: any }>,
  batches: [] as any[],
  added: [] as Array<{ name: string; data: any; delay: any }>,
}))

vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: (d: string) => state.blocked.has(d) },
}))
vi.mock('../services/FederationSwitches.js', () => ({
  federationSwitches: async () => state.switches,
}))
vi.mock('../activitypub/ActorService.js', () => ({
  findStoredRemoteAccount: vi.fn(async () => state.stored),
  resolveRemoteAccount: vi.fn(async (u: string, d: string) => {
    state.resolveCalls.push(`${u}@${d}`)
    return state.resolved
  }),
}))
vi.mock('../queue/BullMQManager.js', () => ({
  bullmqManager: {
    addJob: vi.fn(async (name: string, data: any, delay: any) => {
      state.added.push({ name, data, delay })
      return 'job'
    }),
  },
}))
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: () => {
      const b: any = {
        select: () => b,
        eq: () => b,
        is: () => b,
        maybeSingle: async () => ({ data: state.local }),
      }
      return b
    },
    rpc: async (name: string, args: any) => {
      state.rpc.push({ name, args })
      if (name === 'claim_following_import_batch') return { data: state.batches.shift(), error: null }
      return { data: 'followed', error: null }
    },
  }),
}))

import {
  handleFollowingImportJob,
  resolveImportHandle,
  runFollowingImportBatch,
} from '../queue/handlers/followingImportHandler.js'

const finishes = () => state.rpc.filter((c) => c.name === 'finish_following_import_item').map((c) => c.args)

beforeEach(() => {
  state.blocked = new Set()
  state.switches = { inbound: true, outbound: true }
  state.stored = null
  state.resolved = { ok: true, user: { id: 'fetched-id' }, actor: {} }
  state.resolveCalls = []
  state.local = null
  state.rpc = []
  state.batches = []
  state.added = []
})

describe('resolveImportHandle', () => {
  it('refuses a handle with no domain: a bare name could be someone else here', async () => {
    expect(await resolveImportHandle('alice')).toMatchObject({ failure: 'invalid_handle' })
    expect(await resolveImportHandle('a b@c.test')).toMatchObject({ failure: 'invalid_handle' })
  })

  it('reads a local account from the database, with no fetch', async () => {
    state.local = { id: 'local-id' }
    expect(await resolveImportHandle('bob@HARMONY.test')).toEqual({ id: 'local-id', fetched: false })
    expect(state.resolveCalls).toEqual([])
  })

  it('reports a local account that does not exist as not found', async () => {
    expect(await resolveImportHandle('nobody@harmony.test')).toMatchObject({ failure: 'not_found' })
  })

  it('does not contact a blocked instance', async () => {
    state.blocked.add('bad.test')
    expect(await resolveImportHandle('x@bad.test')).toMatchObject({ failure: 'instance_blocked' })
    expect(state.resolveCalls).toEqual([])
  })

  it.each([
    [{ inbound: false, outbound: true }],
    [{ inbound: true, outbound: false }],
  ])('does not contact another instance while a federation switch is off: %j', async (switches) => {
    state.switches = switches
    expect(await resolveImportHandle('x@far.test')).toMatchObject({ failure: 'federation_off' })
    expect(state.resolveCalls).toEqual([])
  })

  it('follows a profile stored in the last day without a fetch', async () => {
    state.stored = { id: 'stored-id', last_synced_at: new Date(Date.now() - 3600_000).toISOString() }
    expect(await resolveImportHandle('x@far.test')).toEqual({ id: 'stored-id', fetched: false })
    expect(state.resolveCalls).toEqual([])
  })

  it('fetches a stored profile older than a day', async () => {
    state.stored = { id: 'stored-id', last_synced_at: new Date(Date.now() - 2 * 86_400_000).toISOString() }
    expect(await resolveImportHandle('x@far.test')).toEqual({ id: 'fetched-id', fetched: true })
    expect(state.resolveCalls).toEqual(['x@far.test'])
  })

  it('falls back on the stored row when the fetch fails', async () => {
    state.stored = { id: 'stored-id', last_synced_at: null }
    state.resolved = { ok: false, status: 502, body: {} }
    expect(await resolveImportHandle('x@far.test')).toEqual({ id: 'stored-id', fetched: true })
  })

  it('takes 404 as final and a server failure as worth retrying', async () => {
    state.resolved = { ok: false, status: 404, body: {} }
    expect(await resolveImportHandle('x@far.test')).toMatchObject({ failure: 'not_found' })
    expect((await resolveImportHandle('x@far.test') as any).retry).toBeUndefined()

    for (const status of [500, 502, 504, 429]) {
      state.resolved = { ok: false, status, body: {} }
      expect(await resolveImportHandle('x@far.test')).toMatchObject({ failure: 'unreachable', retry: true })
    }
  })

  it('takes any other refusal as final', async () => {
    state.resolved = { ok: false, status: 409, body: {} }
    const result = await resolveImportHandle('x@far.test') as any
    expect(result.failure).toBe('not_found')
    expect(result.retry).toBeUndefined()
  })
})

describe('runFollowingImportBatch', () => {
  it('asks for the follow when a handle resolves and names the failure when not', async () => {
    state.local = { id: 'local-id' }
    state.batches = [{ finished: false, items: [
      { id: 1, handle: 'bob@harmony.test' },
      { id: 2, handle: 'broken' },
    ] }]
    expect(await runFollowingImportBatch('imp')).toEqual({ finished: false, retryAfter: 0 })
    expect(finishes()).toEqual(expect.arrayContaining([
      { p_item_id: 1, p_target_profile_id: 'local-id', p_failure: null, p_retry_seconds: null },
      { p_item_id: 2, p_target_profile_id: null, p_failure: 'invalid_handle', p_retry_seconds: null },
    ]))
  })

  it('asks for a retry after an unreachable host', async () => {
    state.resolved = { ok: false, status: 502, body: {} }
    state.batches = [{ finished: false, items: [{ id: 3, handle: 'x@far.test' }] }]
    await runFollowingImportBatch('imp')
    expect(finishes()).toEqual([{ p_item_id: 3, p_target_profile_id: null, p_failure: 'unreachable', p_retry_seconds: 600 }])
  })

  it('takes a throw while resolving as unreachable, so the batch carries on', async () => {
    state.resolved = null
    state.batches = [{ finished: false, items: [{ id: 4, handle: 'x@far.test' }, { id: 5, handle: 'y@near.test' }] }]
    await runFollowingImportBatch('imp')
    expect(finishes().map((f) => f.p_item_id).sort()).toEqual([4, 5])
    expect(finishes().every((f) => f.p_failure === 'unreachable' && f.p_retry_seconds === 600)).toBe(true)
  })

  it('reports a finished import and an empty claim with its wait', async () => {
    state.batches = [{ finished: true }]
    expect(await runFollowingImportBatch('imp')).toEqual({ finished: true, retryAfter: 0 })
    state.batches = [{ finished: false, items: [], retry_after: 120 }]
    expect(await runFollowingImportBatch('imp')).toEqual({ finished: false, retryAfter: 120 })
    expect(finishes()).toEqual([])
  })
})

describe('handleFollowingImportJob', () => {
  it('drops a job without an import id', async () => {
    await handleFollowingImportJob({ type: 'create' } as any)
    expect(state.rpc).toEqual([])
  })

  it('queues the next job until the import finishes, after the claim\'s wait', async () => {
    state.batches = [{ finished: false, items: [], retry_after: 90 }]
    await handleFollowingImportJob({ type: 'create', import_id: 'imp' } as any)
    expect(state.added).toEqual([{ name: 'following-import', data: { type: 'create', import_id: 'imp' }, delay: 90_000 }])

    state.added = []
    state.batches = [{ finished: true }]
    await handleFollowingImportJob({ type: 'create', import_id: 'imp' } as any)
    expect(state.added).toEqual([])
  })
})
