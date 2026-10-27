import { describe, expect, it, vi } from 'vitest'

// A Drive download URL stays valid as long as a chat attachment's: the desktop download resumes
// with Range on the same URL.

const createSignedUrl = vi.hoisted(() => vi.fn(async (path: string) => ({
  data: { signedUrl: `https://db.test/storage/v1/object/sign/message_media/${path}?token=t` },
  error: null,
})))
vi.mock('@/supabase', () => ({
  SUPABASE_URL: 'https://db.test',
  SUPABASE_ANON_KEY: 'anon',
  supabase: { storage: { from: () => ({ createSignedUrl }) } },
}))
vi.mock('@/services/instanceConfig', () => ({ apiUrl: (p: string) => p }))

const { driveDownloadUrl } = await import('../driveService')
const { VIEW_URL_TTL_SECONDS } = await import('@/services/privateMedia')

describe('driveDownloadUrl', () => {
  it('signs a private file for the lifetime of a chat attachment URL, under its Drive name', async () => {
    const url = await driveDownloadUrl({ bucket: 'message_media', path: 'u/x/a.zip', name: 'a & b.zip' })
    expect(createSignedUrl).toHaveBeenCalledWith('u/x/a.zip', VIEW_URL_TTL_SECONDS)
    expect(VIEW_URL_TTL_SECONDS).toBeGreaterThanOrEqual(6 * 60 * 60)
    expect(new URL(url).searchParams.get('download')).toBe('a & b.zip')
  })
})
