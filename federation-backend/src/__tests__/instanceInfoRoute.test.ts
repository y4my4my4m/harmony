import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import supertest from 'supertest'

const cfg = vi.hoisted(() => ({
  INSTANCE_NAME: 'Harmony Test', INSTANCE_DOMAIN: 'harmony.test', VERSION: '1.9.0',
  PUBLIC_SUPABASE_URL: 'https://db.harmony.test', SUPABASE_ANON_KEY: 'anon',
}))
vi.mock('../config/index.js', () => ({ default: cfg, config: cfg }))

const { default: instanceInfo } = await import('../routes/instanceInfo.js')

describe('GET /instance-info', () => {
  it('names the instance, its version and what it supports, for the native apps', async () => {
    const app = express()
    app.use('/instance-info', instanceInfo)
    const res = await supertest(app).get('/instance-info')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      domain: 'harmony.test', version: '1.9.0', supabaseUrl: 'https://db.harmony.test', supabaseAnonKey: 'anon',
    })
    expect(res.body.capabilities).toContain('encrypted-history')
  })
})
