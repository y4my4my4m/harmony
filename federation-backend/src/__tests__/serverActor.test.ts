import crypto from 'crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The Group actor of a local server signs its own activities with a key stored in
// public.server_actor_keys, generated on first use. A remote server's copy has no key.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const LOCAL = '00000000-0000-4000-8000-0000000000a1'
const REMOTE_COPY = '00000000-0000-4000-8000-0000000000a2'

const servers = [
  { id: LOCAL, is_local_server: true },
  { id: REMOTE_COPY, is_local_server: false },
]
let keys: Array<{ server_id: string; public_key: string; private_key: string }> = []
let upserts = 0

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: (table: string) => {
      let id: string | null = null
      const q: any = {
        select: () => q,
        eq: (_col: string, v: string) => { id = v; return q },
        maybeSingle: () => Promise.resolve({
          data: table === 'servers'
            ? servers.find((s) => s.id === id) ?? null
            : keys.find((k) => k.server_id === id) ?? null,
          error: null,
        }),
        upsert: (row: any, opts: any) => {
          upserts += 1
          expect(opts).toEqual({ onConflict: 'server_id', ignoreDuplicates: true })
          if (!keys.some((k) => k.server_id === row.server_id)) keys.push(row)
          return Promise.resolve({ error: null })
        },
      }
      return q
    },
  }),
}))

const { getServerActorKeys, signAsServer, serverActorKeyId, __resetServerActorKeyCache } =
  await import('../activitypub/ServerActor.js')

beforeEach(() => {
  keys = []
  upserts = 0
  __resetServerActorKeyCache()
})

describe('Group actor key', () => {
  it('is generated once for a local server, then read back', async () => {
    const [a, b] = await Promise.all([getServerActorKeys(LOCAL), getServerActorKeys(LOCAL)])
    expect(a).toBe(b)
    expect(upserts).toBe(1)
    expect(keys).toHaveLength(1)
    expect(a.publicKey).toContain('BEGIN PUBLIC KEY')

    __resetServerActorKeyCache()
    expect((await getServerActorKeys(LOCAL)).publicKey).toBe(a.publicKey)
    expect(upserts).toBe(1)
  })

  it('does not exist for a remote server copy', async () => {
    await expect(getServerActorKeys(REMOTE_COPY)).rejects.toThrow(/not a local server/)
    expect(upserts).toBe(0)
  })

  it('signs with the Group keyId, verifiable against the published key', async () => {
    const body = { type: 'Accept', actor: `https://harmony.test/servers/${LOCAL}` }
    const { headers } = await signAsServer(LOCAL, 'https://peer.test/users/p/inbox', 'POST', body)

    expect(serverActorKeyId(LOCAL)).toBe(`https://harmony.test/servers/${LOCAL}#main-key`)
    expect(headers.Signature).toContain(`keyId="https://harmony.test/servers/${LOCAL}#main-key"`)
    expect(headers.Signature).toContain('headers="(request-target) host date digest"')

    const signature = /signature="([^"]+)"/.exec(headers.Signature)![1]
    const signingString = [
      '(request-target): post /users/p/inbox',
      `host: ${headers.Host}`,
      `date: ${headers.Date}`,
      `digest: ${headers.Digest}`,
    ].join('\n')
    const { publicKey } = await getServerActorKeys(LOCAL)
    expect(crypto.createVerify('SHA256').update(signingString).verify(publicKey, signature, 'base64')).toBe(true)
  })
})
