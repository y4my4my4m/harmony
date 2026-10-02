import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// GET /messages/:id serves a channel message under its channel's read rules, and a
// conversation message to a signer whose instance has a participant.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
}))

const PRIVATE_CHANNEL_MSG = '00000000-0000-4000-8000-0000000000e1'
const PUBLIC_CHANNEL_MSG = '00000000-0000-4000-8000-0000000000e2'
const DM = '00000000-0000-4000-8000-0000000000e3'

const MESSAGES: Record<string, any> = {
  [PRIVATE_CHANNEL_MSG]: { channel_id: 'c-priv', channel: { server_id: 's-priv' } },
  [PUBLIC_CHANNEL_MSG]: { channel_id: 'c-pub', channel: { server_id: 's-pub' } },
  [DM]: { channel_id: null, channel: null, conversation: { id: 'conv', type: 'direct' } },
}

const rpc = vi.fn(async (name: string, args: any) =>
  name === 'federation_conversation_access'
    ? { data: args.p_conversation_id === 'conv' && args.p_domain === signerHost, error: null }
    : { data: null, error: { message: `unexpected ${name}` } })
let signerHost = 'remote.test'

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    rpc: (name: string, args: any) => rpc(name, args),
    from: () => {
      let id: string | undefined
      const q: any = {
        select: () => q,
        eq: (col: string, val: string) => { if (col === 'id') id = val; return q },
        single: () => Promise.resolve({
          data: id && MESSAGES[id]
            ? { id, content: [], created_at: '2026-01-01', metadata: {}, user: { id: 'u', username: 'alice' }, ...MESSAGES[id] }
            : null,
          error: null,
        }),
      }
      return q
    },
  }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const verifiedSigner = vi.fn(async (req: any) => (req.headers.signature ? 'https://remote.test/users/rm' : null))
vi.mock('../activitypub/groupAccess.js', async () => {
  const actual = await vi.importActual<any>('../activitypub/groupAccess.js')
  return {
    ...actual,
    verifiedSigner: (req: any) => verifiedSigner(req),
    loadGroupAccess: async (serverId: string, actor: string | null) => ({
      isPublic: serverId === 's-pub',
      memberId: actor ? 'rm' : null,
      everyoneChannelIds: new Set([serverId === 's-pub' ? 'c-pub' : 'c-priv']),
      memberChannelIds: new Set(actor ? ['c-priv', 'c-pub'] : []),
    }),
  }
})

const { default: outboxRouter } = await import('../activitypub/OutboxHandler.js')

function get(id: string, signed = false) {
  const a = express()
  a.use('/', outboxRouter)
  const req = supertest(a).get(`/messages/${id}`).set('Accept', 'application/activity+json')
  return signed ? req.set('Signature', 'keyId="https://remote.test/users/rm#main-key"') : req
}

beforeEach(() => {
  verifiedSigner.mockClear()
  rpc.mockClear()
  signerHost = 'remote.test'
})

describe('GET /messages/:id', () => {
  it('is 404 for a private server\'s channel message without a member signature', async () => {
    const res = await get(PRIVATE_CHANNEL_MSG)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Not found' })
  })

  it('serves it, uncacheable, to a signed member that can view the channel', async () => {
    const res = await get(PRIVATE_CHANNEL_MSG, true)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('private, no-store')
  })

  it('serves a public channel\'s message unsigned, cacheable', async () => {
    const res = await get(PUBLIC_CHANNEL_MSG)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('max-age=300')
  })

  it('is 404 for a direct message without a signature', async () => {
    const res = await get(DM)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Not found' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('serves a direct message, uncacheable, to a participant\'s instance', async () => {
    const res = await get(DM, true)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(rpc).toHaveBeenCalledWith('federation_conversation_access', { p_conversation_id: 'conv', p_domain: 'remote.test' })
  })

  it('is 404 for a direct message signed by an instance without a participant', async () => {
    signerHost = 'elsewhere.test'
    const res = await get(DM, true)
    expect(res.status).toBe(404)
  })
})
