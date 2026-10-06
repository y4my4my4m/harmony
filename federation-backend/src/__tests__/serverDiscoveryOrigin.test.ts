import { describe, it, expect, vi, beforeEach } from 'vitest'

// Remote Group documents are trusted only for their own host.

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

const writes: Array<{ table: string; op: string; rows: any }> = []
const server = {
  id: 'ref-1',
  ap_id: 'https://remote.test/servers/11111111-1111-4111-8111-111111111111',
  is_local_server: false,
  federation_metadata: {},
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: (table: string) => {
      const c: any = {
        select: () => c,
        eq: () => c,
        in: () => c,
        update: (rows: any) => { writes.push({ table, op: 'update', rows }); return c },
        insert: (rows: any) => { writes.push({ table, op: 'insert', rows }); return Promise.resolve({ error: null }) },
        single: () => Promise.resolve({ data: table === 'servers' ? server : null, error: null }),
        upsert: (rows: any) => { writes.push({ table, op: 'upsert', rows }); return Promise.resolve({ error: null }) },
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
const { safeFetch } = await import('../utils/ssrfProtection.js')
const { SignatureService } = await import('../activitypub/SignatureService.js')

const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 })

beforeEach(() => {
  writes.length = 0
  vi.mocked(safeFetch).mockReset()
  vi.mocked(SignatureService.signedApFetch).mockReset()
})

describe('fetchServerByUrl', () => {
  it('rejects a Group whose id is on another host', async () => {
    vi.mocked(SignatureService.signedApFetch).mockResolvedValue(json({
      type: 'Group',
      id: 'https://harmony.test/servers/22222222-2222-4222-8222-222222222222',
      inbox: 'https://harmony.test/servers/22222222-2222-4222-8222-222222222222/inbox',
    }))

    await expect(ServerDiscoveryService.fetchServerByUrl('https://evil.test/g')).resolves.toBeNull()
  })

  it('rejects a Group whose inbox is on another host', async () => {
    vi.mocked(SignatureService.signedApFetch).mockResolvedValue(json({
      type: 'Group',
      id: 'https://remote.test/servers/1',
      inbox: 'https://evil.test/inbox',
    }))

    await expect(ServerDiscoveryService.fetchServerByUrl('https://remote.test/servers/1')).resolves.toBeNull()
  })

  it('accepts a Group served by its own host', async () => {
    vi.mocked(SignatureService.signedApFetch).mockResolvedValue(json({
      type: 'Group',
      id: 'https://remote.test/servers/1',
      inbox: 'https://remote.test/servers/1/inbox',
    }))

    await expect(ServerDiscoveryService.fetchServerByUrl('https://remote.test/servers/1')).resolves.toMatchObject({
      id: 'https://remote.test/servers/1',
    })
  })
})

describe('syncRemoteServer', () => {
  it('only writes channels under the Group\'s own id', async () => {
    vi.mocked(SignatureService.signedApFetch).mockResolvedValue(json({
      type: 'Group',
      id: server.ap_id,
      inbox: `${server.ap_id}/inbox`,
      name: 'Remote',
      'harmony:channels': [
        { id: `${server.ap_id}/channels/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, name: 'general', type: 'harmony:TextChannel' },
        { id: 'https://other.test/servers/9/channels/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'hijacked', type: 'harmony:TextChannel' },
      ],
    }))

    await ServerDiscoveryService.syncRemoteServer('ref-1', { asUserId: 'local-1' })

    const channelRows = writes.filter((u) => u.table === 'channels').flatMap((u) => u.rows)
    expect(channelRows.map((r: any) => r.name)).toEqual(['general'])
    expect(channelRows[0].id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  })
})
