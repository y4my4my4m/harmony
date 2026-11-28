import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

const cfg = vi.hoisted(() => ({
  INSTANCE_NAME: 'Harmony Test', INSTANCE_DOMAIN: 'harmony.test', VERSION: '1.9.0',
  PUBLIC_SUPABASE_URL: 'https://db.harmony.test', SUPABASE_ANON_KEY: 'anon',
}))
vi.mock('../config/index.js', () => ({ default: cfg, config: cfg }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// instance_config.instance_name as PostgREST answers it; undefined is no row, an Error a failed read.
const stored = vi.hoisted(() => ({ name: 'Example Chat' as unknown }))
function instanceConfig(table: string) {
  if (table !== 'instance_config') throw new Error(`unexpected table ${table}`)
  const read = async () => stored.name instanceof Error
    ? { data: null, error: { message: stored.name.message } }
    : { data: stored.name === undefined ? null : { config_value: stored.name }, error: null }
  const chain: any = { select: () => chain, eq: () => chain, maybeSingle: read }
  return chain
}

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({ from: instanceConfig }) }))

const { default: instanceInfo } = await import('../routes/instanceInfo.js')
const { clearInstanceNameCache } = await import('../utils/instanceName.js')

function get() {
  const app = express()
  app.use('/instance-info', instanceInfo)
  return supertest(app).get('/instance-info')
}

beforeEach(() => {
  clearInstanceNameCache()
  stored.name = 'Example Chat'
})

describe('GET /instance-info', () => {
  it('names the instance, its version and what it supports, for the native apps', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      name: 'Example Chat', domain: 'harmony.test', version: '1.9.0', supabaseUrl: 'https://db.harmony.test', supabaseAnonKey: 'anon',
    })
    expect(res.body.capabilities).toContain('encrypted-history')
  })

  it('names the instance INSTANCE_NAME without a stored name, or when reading it fails', async () => {
    for (const name of [undefined, '', new Error('down')]) {
      clearInstanceNameCache()
      stored.name = name
      const res = await get()
      expect(res.status).toBe(200)
      expect(res.body.name).toBe('Harmony Test')
    }
  })
})
