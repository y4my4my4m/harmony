import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', KLIPY_BASE_URL: 'https://api.klipy.test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { parseGenerationPayload } = await import('../services/KlipyService.js')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Klipy generated emoji download', () => {
  it('refuses an image URL on a private address without fetching it', async () => {
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      status: 200, headers: { 'content-type': 'image/png' },
    }))
    vi.stubGlobal('fetch', fetchSpy)

    const payload = { status: 'success', data: { url: 'http://169.254.169.254/latest/meta-data/emoji.png' } }

    await expect(parseGenerationPayload(payload)).rejects.toThrow(/Blocked/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('downloads an image URL on a public address', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png, {
      status: 200, headers: { 'content-type': 'image/png' },
    })))

    const payload = { status: 'success', data: { url: 'https://93.184.216.34/emoji.png' } }

    const status = await parseGenerationPayload(payload)
    expect(status.state).toBe('success')
    expect(status.state === 'success' && status.image.mimeType).toBe('image/png')
  })
})
