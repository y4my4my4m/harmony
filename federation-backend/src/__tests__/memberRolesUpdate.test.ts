import { beforeEach, describe, expect, it, vi } from 'vitest'

// Update(harmony:MemberRoles) from a Group: a role the copy lacks has the Group read first, once.

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    PORT: 3001,
    NODE_ENV: 'test',
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_ANON_KEY: 'test-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    USE_BULLMQ_QUEUE: false,
    CORS_ORIGIN: 'http://localhost:5173',
    REQUIRE_VALID_SIGNATURES: true,
    ALLOW_FEDERATED_VOICE: true,
    WEBRTC_MODE: 'hybrid',
    FEDERATION_MODE: 'unified',
  },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const GROUP = 'https://remote.test/servers/11111111-1111-4111-8111-111111111111'
const ROLE = `${GROUP}/roles/33333333-3333-4333-8333-333333333333`
const NEW_ROLE = `${GROUP}/roles/44444444-4444-4444-8444-444444444444`

let storedRoles: string[]
const calls: string[] = []

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: { id: 'ref-1', ap_id: GROUP, federation_enabled: true }, error: null }),
      }
      return q
    },
  }),
}))
vi.mock('../services/CopyMirrorService.js', () => ({
  CopyMirrorService: {
    unknownRoles: vi.fn(async (_serverId: string, ids: string[]) => ids.filter(id => !storedRoles.includes(id))),
    applyMemberRoles: vi.fn(async () => { calls.push(`apply:${storedRoles.join(',')}`); return 1 }),
  },
}))
vi.mock('../services/ServerDiscoveryService.js', () => ({
  ServerDiscoveryService: {
    syncRemoteServerShared: vi.fn(async () => { calls.push('sync'); storedRoles = [ROLE, NEW_ROLE] }),
  },
}))

const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js')
const { ServerDiscoveryService } = await import('../services/ServerDiscoveryService.js')
const { CopyMirrorService } = await import('../services/CopyMirrorService.js')

const update = (roles: string[]) => (ActivityProcessor as any).processMemberRolesUpdate(GROUP, {
  type: 'harmony:MemberRoles', id: `${GROUP}/members/u1/roles`, member: 'https://member.test/users/ann', roles,
})

beforeEach(() => {
  storedRoles = [ROLE]
  calls.length = 0
  vi.mocked(ServerDiscoveryService.syncRemoteServerShared).mockClear()
  vi.mocked(CopyMirrorService.applyMemberRoles).mockClear()
})

describe('Update(harmony:MemberRoles)', () => {
  it('applies the roles at once when the copy holds each of them', async () => {
    await update([ROLE])
    expect(ServerDiscoveryService.syncRemoteServerShared).not.toHaveBeenCalled()
    expect(calls).toEqual([`apply:${ROLE}`])
  })

  it('reads the Group first, once, when a role is not on the copy yet', async () => {
    await update([ROLE, NEW_ROLE])
    expect(ServerDiscoveryService.syncRemoteServerShared).toHaveBeenCalledTimes(1)
    expect(ServerDiscoveryService.syncRemoteServerShared).toHaveBeenCalledWith('ref-1')
    expect(calls).toEqual(['sync', `apply:${ROLE},${NEW_ROLE}`])
    expect(vi.mocked(CopyMirrorService.applyMemberRoles).mock.calls[0][2]).toEqual([
      { member: 'https://member.test/users/ann', roles: [ROLE, NEW_ROLE] },
    ])
  })

  it('applies what exists after one read when the Group still lacks the role', async () => {
    vi.mocked(ServerDiscoveryService.syncRemoteServerShared).mockImplementationOnce(async () => { calls.push('sync') })
    await update([NEW_ROLE])
    expect(calls).toEqual(['sync', `apply:${ROLE}`])
  })
})

describe('syncRemoteServerShared', () => {
  it('joins concurrent reads of one server', async () => {
    const real = await vi.importActual<typeof import('../services/ServerDiscoveryService.js')>('../services/ServerDiscoveryService.js')
    const Service = real.ServerDiscoveryService
    let release!: () => void
    const sync = vi.spyOn(Service, 'syncRemoteServer').mockImplementation(() => new Promise<void>(r => { release = r }))
    const a = Service.syncRemoteServerShared('ref-1')
    const b = Service.syncRemoteServerShared('ref-1')
    expect(sync).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([a, b])
    void Service.syncRemoteServerShared('ref-1')
    expect(sync).toHaveBeenCalledTimes(2)
    release()
    sync.mockRestore()
  })
})
