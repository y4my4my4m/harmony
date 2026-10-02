import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// /api/federation/realtime: presence answers only for profiles the caller
// shares a server or conversation with, or follows (presence_related_ids);
// typing only in contexts the caller may read (topic_readable_by).

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.profileId = req.headers['x-profile'] as string
    next()
  },
}))
const presence = vi.hoisted(() => ({
  heartbeat: vi.fn(),
  setOffline: vi.fn(),
  getBulkStatus: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { status: 'online', lastSeen: 1 }]))),
  getOnlineIds: vi.fn(async () => ['friend', 'stranger', 'coworker']),
}))
const typing = vi.hoisted(() => ({ startTyping: vi.fn(), stopTyping: vi.fn(), getTypingUsers: vi.fn(async () => []) }))
vi.mock('../services/PresenceService.js', () => ({ presenceService: presence }))
vi.mock('../services/TypingService.js', () => ({ typingService: typing }))
vi.mock('../services/ProfileCacheService.js', () => ({ profileCacheService: { getByIds: vi.fn(async () => new Map()) } }))
vi.mock('../services/RedisService.js', () => ({ redis: { healthCheck: vi.fn(async () => ({ ok: true })) } }))

const RELATED: Record<string, string[]> = { me: ['friend', 'coworker'] }
const READABLE = new Set(['me|typing:conversation:c1'])
const rpc = vi.hoisted(() => vi.fn())
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({ rpc }) }))

const { default: realtimeRouter } = await import('../routes/realtime.js')
const app = express()
app.use(express.json())
app.use('/', realtimeRouter)
const as = (profile: string) => ({
  post: (path: string, body: any) => supertest(app).post(path).set('x-profile', profile).send(body),
  get: (path: string) => supertest(app).get(path).set('x-profile', profile),
})

beforeEach(() => {
  rpc.mockReset().mockImplementation(async (fn: string, args: any) => {
    if (fn === 'presence_related_ids') {
      return { data: (args.p_ids as string[]).filter((id) => RELATED[args.p_viewer]?.includes(id)), error: null }
    }
    if (fn === 'topic_readable_by') return { data: READABLE.has(`${args.p_profile_id}|${args.p_topic}`), error: null }
    return { data: null, error: { message: `unexpected ${fn}` } }
  })
  typing.startTyping.mockClear()
  typing.getTypingUsers.mockClear()
})

describe('presence', () => {
  it('bulk answers only for related profiles', async () => {
    const res = await as('me').post('/presence/bulk', { profileIds: ['friend', 'stranger'] })
    expect(Object.keys(res.body.presence)).toEqual(['friend'])
    expect(presence.getBulkStatus).toHaveBeenLastCalledWith(['friend'])
  })

  it('online lists only related profiles', async () => {
    const res = await as('me').get('/presence/online')
    expect(res.body.online.sort()).toEqual(['coworker', 'friend'])
  })

  it('a failed relation lookup answers nothing', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'down' } })
    expect((await as('me').get('/presence/online')).body.online).toEqual([])
  })
})

describe('typing', () => {
  it('reads and writes only contexts the caller may read', async () => {
    expect((await as('me').post('/typing/active', { contextType: 'conversation', contextId: 'c2' })).status).toBe(403)
    expect((await as('me').post('/typing/start', { contextType: 'conversation', contextId: 'c2', username: 'me' })).status).toBe(403)
    expect(typing.startTyping).not.toHaveBeenCalled()
    expect((await as('me').post('/typing/active', { contextType: 'conversation', contextId: 'c1' })).status).toBe(200)
    expect((await as('me').post('/typing/start', { contextType: 'conversation', contextId: 'c1', username: 'me' })).status).toBe(200)
    expect(typing.startTyping).toHaveBeenCalledWith('conversation', 'c1', 'me', 'me')
  })
})
