import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// NodeInfo usage: users.activeMonth and users.activeHalfyear count local accounts active in
// the past 30 and 180 days (public.nodeinfo_active_users), never local posts.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony Test', INSTANCE_DESCRIPTION: '', VERSION: '1.8.3' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
}))

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-15T12:00:00Z')

// Accounts by the time of their last activity, in days before NOW.
let lastActiveDaysAgo: number[] = []
let rpcError: { message: string } | null = null
const rpc = vi.fn(async (name: string, args: { p_since: string }) => {
  if (name !== 'nodeinfo_active_users') return { data: null, error: { message: `unexpected ${name}` } }
  if (rpcError) return { data: null, error: rpcError }
  const since = Date.parse(args.p_since)
  return { data: lastActiveDaysAgo.filter((d) => NOW - d * DAY >= since).length, error: null }
})
const counts: Record<string, number> = { profiles: 9, posts: 1234 }

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    rpc,
    from: (table: string) => {
      const q: any = {
        select: () => q,
        eq: () => q,
        in: () => q,
        then: (resolve: any) =>
          resolve(table === 'instance_config' ? { data: [], error: null } : { count: counts[table], data: null, error: null }),
      }
      return q
    },
  }),
}))

const { default: nodeInfoRouter, __resetNodeInfoUsageCache } = await import('../activitypub/NodeInfoService.js')

function app() {
  const a = express()
  a.use('/', nodeInfoRouter)
  return a
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  rpc.mockClear()
  rpcError = null
  lastActiveDaysAgo = [1, 12, 29, 45, 120, 179, 200, 400]
  __resetNodeInfoUsageCache()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('NodeInfo usage', () => {
  it.each(['2.0', '2.1'])('%s counts accounts active in the month and the half year', async (version) => {
    const res = await supertest(app()).get(`/nodeinfo/${version}`)
    expect(res.status).toBe(200)
    expect(res.body.usage).toEqual({
      users: { total: 9, activeMonth: 3, activeHalfyear: 6 },
      localPosts: 1234,
    })
  })

  it('asks for the past 30 and 180 days', async () => {
    await supertest(app()).get('/nodeinfo/2.1')
    expect(rpc.mock.calls.map((c) => (NOW - Date.parse((c[1] as any).p_since)) / DAY).sort((a, b) => a - b))
      .toEqual([30, 180])
  })

  it('reports no active accounts, never the post count, when the count is unavailable', async () => {
    rpcError = { message: 'function public.nodeinfo_active_users does not exist' }
    const res = await supertest(app()).get('/nodeinfo/2.0')
    expect(res.body.usage.users).toEqual({ total: 9, activeMonth: 0, activeHalfyear: 0 })
    expect(res.body.usage.localPosts).toBe(1234)
  })

  it('computes the usage once per 10 minutes', async () => {
    await supertest(app()).get('/nodeinfo/2.0')
    await supertest(app()).get('/nodeinfo/2.1')
    expect(rpc).toHaveBeenCalledTimes(2)

    vi.setSystemTime(NOW + 11 * 60 * 1000)
    await supertest(app()).get('/nodeinfo/2.1')
    expect(rpc).toHaveBeenCalledTimes(4)
  })
})
