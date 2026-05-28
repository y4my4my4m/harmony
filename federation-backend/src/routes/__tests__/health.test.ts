import { describe, it, expect, vi } from 'vitest'
import express from 'express'

vi.mock('../../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    PORT: 3001,
    NODE_ENV: 'test',
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_ANON_KEY: 'test-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:54322/postgres',
    USE_BULLMQ_QUEUE: false,
    CORS_ORIGIN: 'http://localhost:5173',
    INSTANCE_NAME: 'Test Instance',
  },
}))

vi.mock('../../config/supabase.js', () => ({
  getSupabaseClient: vi.fn(() => ({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    }),
  })),
}))

import { default as supertest } from 'supertest'

async function createTestApp() {
  const app = express()
  const { default: healthRouter } = await import('../../routes/health.js')
  app.use('/health', healthRouter)
  return app
}

describe('Health endpoint', () => {
  it('GET /health returns 200', async () => {
    const app = await createTestApp()
    const response = await supertest(app).get('/health')
    expect(response.status).toBe(200)
  })

  it('GET /health returns JSON with status', async () => {
    const app = await createTestApp()
    const response = await supertest(app).get('/health')
    expect(response.body).toHaveProperty('status')
  })
})
