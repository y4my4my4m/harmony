import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// GET /drive/link/<token>: a live link redirects to a short-lived signed storage URL (as an
// attachment with download=1); anything else is a 404 without touching storage.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_URL: 'http://kong:8000' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../utils/urlUtils.js', () => ({ makeUrlPublic: (url: string) => url.replace('http://kong:8000', 'https://db.harmony.test') }))

const rpc = vi.fn()
const sign = vi.fn()
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    rpc: (...args: unknown[]) => rpc(...args),
    storage: { from: (bucket: string) => ({ createSignedUrl: (...args: unknown[]) => sign(bucket, ...args) }) },
  }),
}))

const { default: driveLinkRouter } = await import('../routes/driveLink.js')
const app = express()
app.use('/drive', driveLinkRouter)

const TOKEN = 'h5KAj-hPSm5hwCpMfeKM8aZl'

beforeEach(() => {
  rpc.mockReset()
  sign.mockReset()
  sign.mockResolvedValue({ data: { signedUrl: 'http://kong:8000/storage/v1/object/sign/message_media/u/x.mp4?token=t' }, error: null })
})

describe('drive link route', () => {
  it('redirects a live link to a signed URL on the public storage origin', async () => {
    rpc.mockResolvedValue({ data: [{ bucket: 'message_media', path: 'u/x.mp4', name: 'clip.mp4' }], error: null })
    const res = await supertest(app).get(`/drive/link/${TOKEN}`)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('https://db.harmony.test/storage/v1/object/sign/message_media/u/x.mp4?token=t')
    expect(rpc).toHaveBeenCalledWith('drive_link_target', { p_token: TOKEN })
    expect(sign).toHaveBeenCalledWith('message_media', 'u/x.mp4', 300, undefined)
  })

  it('asks storage for an attachment under the Drive name with download=1', async () => {
    rpc.mockResolvedValue({ data: [{ bucket: 'message_media', path: 'u/x.mp4', name: 'clip.mp4' }], error: null })
    await supertest(app).get(`/drive/link/${TOKEN}?download=1`)
    expect(sign).toHaveBeenCalledWith('message_media', 'u/x.mp4', 300, { download: 'clip.mp4' })
  })

  it('answers 404 for an expired, revoked or unknown link', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    const res = await supertest(app).get(`/drive/link/${TOKEN}`)
    expect(res.status).toBe(404)
    expect(sign).not.toHaveBeenCalled()
  })

  it('answers 404 for a malformed token without asking the database', async () => {
    const res = await supertest(app).get('/drive/link/..%2F..%2Fetc')
    expect(res.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })
})
