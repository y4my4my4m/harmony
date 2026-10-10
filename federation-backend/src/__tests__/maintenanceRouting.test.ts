import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// FEDERATION_MODE=server starts no BullMQ workers. A maintenance job triggered
// through /health/maintenance is added to the 'maintenance' queue on the shared
// Redis, where the worker process consumes it.

const config = vi.hoisted(() => ({ INSTANCE_DOMAIN: 'harmony.test', USE_BULLMQ_QUEUE: true }))
vi.mock('../config/index.js', () => ({ default: config }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const added = vi.hoisted(() => [] as Array<{ queue: string; name: string; data: any; prefix: string }>)
vi.mock('bullmq', () => {
  class Queue {
    constructor(public name: string, public opts: any) {}
    async add(name: string, data: any) {
      added.push({ queue: this.name, name, data, prefix: this.opts.prefix })
      return { id: `job-${added.length}` }
    }
    async close() {}
  }
  return { Queue, Worker: class {}, QueueEvents: class {} }
})

const redisClient = vi.hoisted(() => ({ value: { options: { host: 'redis', port: 6379, keyPrefix: 'harmony:' } } as any }))
vi.mock('../services/RedisService.js', () => ({
  redis: { getClient: () => redisClient.value, healthCheck: async () => ({ ok: true, latencyMs: 1 }) },
}))

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = { id: 'admin-auth' }; next() },
}))
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: () => {
      const c: any = { select: () => c, eq: () => c, single: async () => ({ data: { is_admin: true }, error: null }) }
      return c
    },
  }),
}))

const { bullmqManager } = await import('../queue/BullMQManager.js')
const { default: healthRouter } = await import('../routes/health.js')

function app() {
  const a = express()
  a.use(express.json())
  a.use('/health', healthRouter)
  return a
}

beforeEach(async () => {
  added.length = 0
  config.USE_BULLMQ_QUEUE = true
  redisClient.value = { options: { host: 'redis', port: 6379, keyPrefix: 'harmony:' } }
  await bullmqManager.stop()
})

describe('maintenance job routing', () => {
  it('queues a maintenance job from a process without workers', async () => {
    const res = await supertest(app()).post('/health/maintenance').send({ task: 'cleanup-orphans' })

    expect(res.status).toBe(200)
    expect(res.body.job_id).toBe('job-1')
    expect(added).toEqual([{
      queue: 'maintenance',
      name: 'maintenance',
      data: { type: 'create', task: 'cleanup-orphans', triggered_by: 'api' },
      prefix: 'harmony',
    }])
  })

  it('reuses one producer queue per job type', async () => {
    await bullmqManager.addJob('maintenance', { type: 'create', task: 'keygen-sweep' })
    await bullmqManager.addJob('maintenance', { type: 'create', task: 'verify-federation' })
    expect(added.map((a) => a.data.task)).toEqual(['keygen-sweep', 'verify-federation'])
  })

  it('refuses an unknown job type', async () => {
    expect(await bullmqManager.addJob('no-such-job', { type: 'create' })).toBeUndefined()
    expect(added).toEqual([])
  })

  it('answers 503 when BullMQ is off, rather than reporting a job that never runs', async () => {
    config.USE_BULLMQ_QUEUE = false
    const res = await supertest(app()).post('/health/maintenance').send({ task: 'keygen-sweep' })
    expect(res.status).toBe(503)
    expect(added).toEqual([])
  })

  it('answers 503 without Redis', async () => {
    redisClient.value = null
    const res = await supertest(app()).post('/health/maintenance').send({ task: 'keygen-sweep' })
    expect(res.status).toBe(503)
  })
})
