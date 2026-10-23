import { describe, it, expect, vi, beforeEach } from 'vitest'

// A copy's owner is the Group's attributedTo, stored as a remote profile; never a local profile
// (migration 20261027200001).

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', VERSION: 'test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => fn,
}))
vi.mock('../middleware/rateLimit.js', () => ({
  discoveryLimiter: (_req: any, _res: any, next: any) => next(),
}))
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch: vi.fn(),
  validateExternalHostname: vi.fn(),
}))

const ensureRemoteUser = vi.hoisted(() => vi.fn(async (url: string) => ({ id: `profile:${url}` })))
vi.mock('../activitypub/ActivityProcessor.js', () => ({
  ActivityProcessor: { ensureRemoteUser },
}))

const writes: Array<{ table: string; op: string; rows: any }> = []
const reads: string[] = []
const existing = {
  id: 'ref-1',
  ap_id: 'https://remote.test/servers/11111111-1111-4111-8111-111111111111',
  is_local_server: false,
  owner: 'local-admin',
  federation_metadata: {},
}
const state = { referenceExists: true }

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: (table: string) => {
      reads.push(table)
      let inserted: any = null
      const c: any = {
        select: () => c,
        eq: () => c,
        in: () => c,
        order: () => c,
        limit: () => c,
        update: (rows: any) => { writes.push({ table, op: 'update', rows }); return c },
        insert: (rows: any) => { inserted = rows; writes.push({ table, op: 'insert', rows }); return c },
        upsert: (rows: any) => { writes.push({ table, op: 'upsert', rows }); return Promise.resolve({ error: null }) },
        single: () => Promise.resolve(
          inserted ? { data: { id: 'new-ref', ...inserted }, error: null }
            : { data: table === 'servers' && state.referenceExists ? existing : null, error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (resolve: any) => resolve({ data: [], error: null }),
      }
      return c
    },
  }),
  getSupabaseClientWithAuth: vi.fn(),
}))
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: { signedApFetch: vi.fn() },
}))

const { ServerDiscoveryService } = await import('../services/ServerDiscoveryService.js')
const { SignatureService } = await import('../activitypub/SignatureService.js')

const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 })
const group = (extra: Record<string, unknown> = {}) => ({
  type: 'Group',
  id: existing.ap_id,
  inbox: `${existing.ap_id}/inbox`,
  name: 'Remote',
  'harmony:channels': [],
  ...extra,
})

beforeEach(() => {
  writes.length = 0
  reads.length = 0
  state.referenceExists = true
  ensureRemoteUser.mockClear()
  vi.mocked(SignatureService.signedApFetch).mockReset()
})

describe('resolveGroupOwner', () => {
  it('stores the owner the Group names on its own host', async () => {
    await expect(ServerDiscoveryService.resolveGroupOwner(group({ attributedTo: 'https://remote.test/users/alice' })))
      .resolves.toBe('profile:https://remote.test/users/alice')
    expect(ensureRemoteUser).toHaveBeenCalledWith('https://remote.test/users/alice')
  })

  it('takes no owner on another host, on this instance, or none at all', async () => {
    await expect(ServerDiscoveryService.resolveGroupOwner(group({ attributedTo: 'https://evil.test/users/x' }))).resolves.toBeNull()
    await expect(ServerDiscoveryService.resolveGroupOwner(group({ attributedTo: 'https://harmony.test/users/admin' }))).resolves.toBeNull()
    await expect(ServerDiscoveryService.resolveGroupOwner(group())).resolves.toBeNull()
    expect(ensureRemoteUser).not.toHaveBeenCalled()
  })

  it('answers unknown, not none, when the owner cannot be fetched now', async () => {
    ensureRemoteUser.mockRejectedValueOnce(new Error('timeout'))
    await expect(ServerDiscoveryService.resolveGroupOwner(group({ attributedTo: 'https://remote.test/users/alice' })))
      .resolves.toBeUndefined()
  })
})

describe('groupSuspension', () => {
  it('reads harmony:suspended into the copy\'s columns; null lifts it; absent leaves them', () => {
    expect(ServerDiscoveryService.groupSuspension({ 'harmony:suspended': { at: '2026-10-23T01:00:00.000Z', reason: 'spam' } }))
      .toEqual({ suspended_at: '2026-10-23T01:00:00.000Z', suspended_reason: 'spam' })
    expect(ServerDiscoveryService.groupSuspension({ 'harmony:suspended': null }))
      .toEqual({ suspended_at: null, suspended_reason: null })
    expect(ServerDiscoveryService.groupSuspension({ name: 'Lobby' })).toBeNull()
  })

  it('keeps a reason to 1000 characters and dates a malformed time now', () => {
    const parsed = ServerDiscoveryService.groupSuspension({ 'harmony:suspended': { at: 'soon', reason: 'x'.repeat(2000) } })
    expect(parsed?.suspended_reason).toHaveLength(1000)
    expect(Number.isNaN(Date.parse(parsed!.suspended_at!))).toBe(false)
  })
})

describe('createLocalServerReference', () => {
  it('owns the reference by the host owner, not by a local admin', async () => {
    state.referenceExists = false
    await ServerDiscoveryService.createLocalServerReference(group({ attributedTo: 'https://remote.test/users/alice' }))
    const insert = writes.find((w) => w.table === 'servers' && w.op === 'insert')
    expect(insert?.rows.owner).toBe('profile:https://remote.test/users/alice')
    expect(insert?.rows.is_local_server).toBe(false)
    expect(reads).not.toContain('profiles')
  })

  it('leaves the owner empty when the Group names none', async () => {
    state.referenceExists = false
    await ServerDiscoveryService.createLocalServerReference(group())
    const insert = writes.find((w) => w.table === 'servers' && w.op === 'insert')
    expect(insert?.rows.owner).toBeNull()
  })
})

describe('syncRemoteServer', () => {
  it('replaces the owner with the one the Group names', async () => {
    vi.mocked(SignatureService.signedApFetch).mockResolvedValue(json(group({ attributedTo: 'https://remote.test/users/alice' })))
    await ServerDiscoveryService.syncRemoteServer('ref-1', { asUserId: 'local-1' })
    const update = writes.find((w) => w.table === 'servers' && w.op === 'update')
    expect(update?.rows.owner).toBe('profile:https://remote.test/users/alice')
    expect(update?.rows.federation_metadata.attributedTo).toBe('https://remote.test/users/alice')
  })

  it('clears a local owner when the Group names none', async () => {
    vi.mocked(SignatureService.signedApFetch).mockResolvedValue(json(group()))
    await ServerDiscoveryService.syncRemoteServer('ref-1', { asUserId: 'local-1' })
    const update = writes.find((w) => w.table === 'servers' && w.op === 'update')
    expect(update?.rows.owner).toBeNull()
  })
})
