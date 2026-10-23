import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// GET /instances/probe stores its NodeInfo read (software, version, users.total, localPosts)
// through record_instance_nodeinfo on an existing federated_instances row only.

vi.mock('../config/index.js', () => ({ default: { INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test' } }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../middleware/rateLimit.js', () => ({ discoveryLimiter: (_req: any, _res: any, next: any) => next() }))

const safeFetch = vi.hoisted(() => vi.fn())
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch: (...args: any[]) => safeFetch(...args),
  validateExternalHostname: vi.fn(),
  validateExternalUrl: vi.fn(),
}))

const signedApFetch = vi.hoisted(() => vi.fn())
vi.mock('../activitypub/SignatureService.js', () => ({ SignatureService: { signedApFetch } }))

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({ rpc }) }))

const { default: router } = await import('../routes/instanceProbe.js')
const { forgetInstanceSoftware } = await import('../activitypub/instanceSoftware.js')
const app = express()
app.use('/', router)

const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body })
const probe = (domain: string) => supertest(app).get(`/instances/probe?domain=${encodeURIComponent(domain)}`)

function serveNodeinfo(nodeinfo: unknown | null): void {
  safeFetch.mockImplementation(async (url: string) => {
    if (nodeinfo !== null && url.endsWith('/.well-known/nodeinfo')) {
      return json({ links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: 'https://mony.test/nodeinfo/2.1' }] })
    }
    return json({}, false)
  })
  signedApFetch.mockResolvedValue(json(nodeinfo))
}

beforeEach(() => {
  forgetInstanceSoftware()
  safeFetch.mockReset()
  signedApFetch.mockReset()
  rpc.mockReset().mockResolvedValue({ data: 'harmony', error: null })
})

describe('GET /instances/probe', () => {
  it('stores the NodeInfo answer on the instance\'s row, creating none', async () => {
    serveNodeinfo({ software: { name: 'harmony', version: '1.8.11' }, usage: { users: { total: 2, activeMonth: 1 }, localPosts: 37 } })

    const res = await probe('https://Mony.test/')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ domain: 'mony.test', software: 'harmony', version: '1.8.11', user_count: 2, status_count: 37 })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('record_instance_nodeinfo', {
      p_domain: 'mony.test', p_software: 'harmony', p_version: '1.8.11', p_user_count: 2, p_status_count: 37, p_create: false,
    })
  })

  it('stores absent usage as null and still answers 0', async () => {
    serveNodeinfo({ software: { name: 'Pleroma', version: '2.7.0' } })

    const res = await probe('pleroma.test')
    expect(res.body).toMatchObject({ user_count: 0, status_count: 0 })
    expect(rpc).toHaveBeenCalledWith('record_instance_nodeinfo', expect.objectContaining({
      p_software: 'pleroma', p_user_count: null, p_status_count: null,
    }))
  })

  it('stores nothing without a NodeInfo answer', async () => {
    serveNodeinfo(null)

    const res = await probe('quiet.test')
    expect(res.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('answers when the write fails', async () => {
    serveNodeinfo({ software: { name: 'harmony', version: '1.8.11' }, usage: { users: { total: 2 }, localPosts: 0 } })
    rpc.mockResolvedValue({ data: null, error: { message: 'function does not exist' } })

    const res = await probe('mony.test')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ software: 'harmony', user_count: 2 })
  })
})
