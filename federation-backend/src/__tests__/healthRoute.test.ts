import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// GET /health names the instance as utils/instanceName.ts resolves it.

const config = vi.hoisted(() => ({ INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony', VERSION: '1.9.8', NODE_ENV: 'test' }))
vi.mock('../config/index.js', () => ({ default: config }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../services/RedisService.js', () => ({
  redis: { healthCheck: async () => ({ ok: true, latencyMs: 1 }) },
}))
vi.mock('../queue/BullMQManager.js', () => ({ bullmqManager: { getStats: async () => ({}) } }))
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }))

// instance_config.instance_name as PostgREST answers it; undefined is no row, an Error a failed read.
const stored = vi.hoisted(() => ({ name: 'Example Chat' as unknown }))
function instanceConfig(table: string) {
  if (table === 'profiles') return { select: () => ({ limit: async () => ({ data: [], error: null }) }) }
  if (table !== 'instance_config') throw new Error(`unexpected table ${table}`)
  const read = async () => stored.name instanceof Error
    ? { data: null, error: { message: stored.name.message } }
    : { data: stored.name === undefined ? null : { config_value: stored.name }, error: null }
  const chain: any = { select: () => chain, eq: () => chain, maybeSingle: read }
  return chain
}

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({ from: instanceConfig }) }))

const { default: healthRouter } = await import('../routes/health.js')
const { clearInstanceNameCache } = await import('../utils/instanceName.js')

function get() {
  const app = express()
  app.use('/health', healthRouter)
  return supertest(app).get('/health')
}

beforeEach(() => {
  clearInstanceNameCache()
  stored.name = 'Example Chat'
})

describe('GET /health', () => {
  it('names the instance as the admin panel stores it', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.body.instance).toEqual({ name: 'Example Chat', domain: 'harmony.test' })
  })

  it('names it INSTANCE_NAME, else the domain, without a stored name', async () => {
    stored.name = undefined
    expect((await get()).body.instance.name).toBe('Harmony')
    clearInstanceNameCache()
    config.INSTANCE_NAME = ''
    try {
      expect((await get()).body.instance.name).toBe('harmony.test')
    } finally {
      config.INSTANCE_NAME = 'Harmony'
    }
  })
})
