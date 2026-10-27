import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// GET /drive/link/<token>: the bytes of a public file, streamed from a signed storage URL that never
// reaches the client (its object name names the owner); Range passes through; download=1 is an
// attachment under the Drive name. Anything else is a 404 without touching storage.

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
const SIGNED = 'http://kong:8000/storage/v1/object/sign/message_media/u/0a1b2c3d-auth-uid/x.mp4?token=t'

const storage = vi.fn()
vi.stubGlobal('fetch', (...args: unknown[]) => storage(...args))

function stored(status: number, headers: Record<string, string>, body = 'bytes'): Response {
  return new Response(status === 204 ? null : body, { status, headers })
}

beforeEach(() => {
  rpc.mockReset()
  sign.mockReset()
  storage.mockReset()
  sign.mockResolvedValue({ data: { signedUrl: SIGNED }, error: null })
  storage.mockResolvedValue(stored(200, {
    'content-type': 'video/mp4', 'content-length': '5', 'accept-ranges': 'bytes', etag: '"e1"',
    'content-disposition': 'inline; filename="x.mp4"', 'x-amz-meta-owner': 'u/0a1b2c3d-auth-uid',
  }))
})

describe('drive link route', () => {
  it('streams a live link without naming the storage object', async () => {
    rpc.mockResolvedValue({ data: [{ bucket: 'message_media', path: 'u/0a1b2c3d-auth-uid/x.mp4', name: 'clip.mp4' }], error: null })
    const res = await supertest(app).get(`/drive/link/${TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.body.toString()).toBe('bytes')
    expect(res.headers.location).toBeUndefined()
    expect(res.headers['content-type']).toBe('video/mp4')
    expect(res.headers['content-disposition']).toBeUndefined()
    expect(res.headers['x-amz-meta-owner']).toBeUndefined()
    expect(JSON.stringify(res.headers)).not.toContain('0a1b2c3d')
    expect(res.headers['cache-control']).toBe('private, max-age=60')
    expect(rpc).toHaveBeenCalledWith('drive_link_target', { p_token: TOKEN })
    expect(sign).toHaveBeenCalledWith('message_media', 'u/0a1b2c3d-auth-uid/x.mp4', 300, undefined)
    expect(storage.mock.calls[0][0]).toBe(SIGNED)
  })

  it('passes a Range through and answers 206', async () => {
    rpc.mockResolvedValue({ data: [{ bucket: 'message_media', path: 'u/x.mp4', name: 'clip.mp4' }], error: null })
    storage.mockResolvedValue(stored(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-1/5', 'content-length': '2' }, 'by'))
    const res = await supertest(app).get(`/drive/link/${TOKEN}`).set('Range', 'bytes=0-1')
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe('bytes 0-1/5')
    expect((storage.mock.calls[0][1] as RequestInit).headers).toEqual({ Range: 'bytes=0-1' })
  })

  it('answers 404 when storage no longer has the object', async () => {
    rpc.mockResolvedValue({ data: [{ bucket: 'message_media', path: 'u/x.mp4', name: 'clip.mp4' }], error: null })
    storage.mockResolvedValue(stored(404, { 'content-type': 'application/json' }, '{"error":"u/x.mp4 not found"}'))
    const res = await supertest(app).get(`/drive/link/${TOKEN}`)
    expect(res.status).toBe(404)
    expect(res.text).not.toContain('u/x.mp4')
  })

  it('asks storage for an attachment under the Drive name with download=1', async () => {
    rpc.mockResolvedValue({ data: [{ bucket: 'message_media', path: 'u/x.mp4', name: 'clip.mp4' }], error: null })
    storage.mockResolvedValue(stored(200, { 'content-type': 'video/mp4', 'content-disposition': 'attachment; filename="clip.mp4"' }))
    const res = await supertest(app).get(`/drive/link/${TOKEN}?download=1`)
    expect(sign).toHaveBeenCalledWith('message_media', 'u/x.mp4', 300, undefined)
    expect(storage.mock.calls[0][0]).toBe(`${SIGNED}&download=clip.mp4`)
    expect(res.headers['content-disposition']).toBe('attachment; filename="clip.mp4"')
  })

  it('percent-encodes the whole Drive name: & # + quotes, spaces and non-ASCII survive', async () => {
    const name = 'a&b #1 + "q" ünï.zip'
    rpc.mockResolvedValue({ data: [{ bucket: 'message_media', path: 'u/x.zip', name }], error: null })
    await supertest(app).get(`/drive/link/${TOKEN}?download=1`)
    const url = new URL(storage.mock.calls[0][0] as string)
    expect(url.searchParams.get('download')).toBe(name)
    expect(url.searchParams.get('token')).toBe('t')
  })

  it('signs a render of a raster image with thumb=1', async () => {
    rpc.mockResolvedValue({ data: [{ bucket: 'message_media', path: 'u/x.png', name: 'x.png', mime_type: 'image/png' }], error: null })
    const res = await supertest(app).get(`/drive/link/${TOKEN}?thumb=1`)
    expect(res.status).toBe(200)
    expect(sign).toHaveBeenCalledWith('message_media', 'u/x.png', 300,
      { transform: { width: 1200, height: 630, resize: 'contain', quality: 80 } })
  })

  it('answers 404 to thumb=1 for a file that is not a raster image', async () => {
    rpc.mockResolvedValue({ data: [{ bucket: 'message_media', path: 'u/x.svg', name: 'x.svg', mime_type: 'image/svg+xml' }], error: null })
    const res = await supertest(app).get(`/drive/link/${TOKEN}?thumb=1`)
    expect(res.status).toBe(404)
    expect(sign).not.toHaveBeenCalled()
  })

  it('answers 404 for a restricted, expired, reset or unknown token', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    const res = await supertest(app).get(`/drive/link/${TOKEN}`)
    expect(res.status).toBe(404)
    expect(sign).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
  })

  it('answers 404 for a malformed token without asking the database', async () => {
    const res = await supertest(app).get('/drive/link/..%2F..%2Fetc')
    expect(res.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })
})
