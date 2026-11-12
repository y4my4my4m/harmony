import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mirrorFile: vi.fn(),
  publicUrl: vi.fn((bucket: string, path: string) => `https://h.test/storage/v1/object/public/${bucket}/${path}`),
}))

vi.mock('../../config/supabase.js', () => ({
  supabaseUrl: 'https://h.test',
  supabaseServiceKey: 'k',
  config: {},
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { config_value: 1000 }, error: null }) }) }),
    }),
    storage: {
      from: (bucket: string) => ({
        getPublicUrl: (path: string) => ({ data: { publicUrl: mocks.publicUrl(bucket, path) } }),
      }),
    },
  },
}))
vi.mock('../messageMedia.js', () => ({ MESSAGE_MEDIA_BUCKET: 'message_media', signMessageMediaPaths: vi.fn() }))
vi.mock('../mirrorFile.js', () => ({ mirrorFileToStorage: mocks.mirrorFile }))

import { mirrorExternalMediaToStorage } from '../mirrorExternalMedia.js'

const SRC = 'https://cdn.discordapp.com/avatars/1/abc.png'

beforeEach(() => {
  mocks.mirrorFile.mockReset()
  mocks.publicUrl.mockClear()
})

describe('mirrorExternalMediaToStorage target', () => {
  it('returns the bucket public URL for a target and passes it through with the ceiling', async () => {
    mocks.mirrorFile.mockResolvedValue({ path: 'u1/avatar-5.png', url: '', contentType: 'image/png', bytes: 3 })
    const target = { bucket: 'avatars', folder: 'u1', stem: 'avatar' }
    const out = await mirrorExternalMediaToStorage(SRC, { target })
    expect(mocks.mirrorFile).toHaveBeenCalledWith(SRC, { target, ceiling: 1000 })
    expect(out).toEqual({
      path: 'u1/avatar-5.png',
      url: 'https://h.test/storage/v1/object/public/avatars/u1/avatar-5.png',
      contentType: 'image/png',
    })
  })

  it('without a target returns the signed url from mirrorFile unchanged', async () => {
    mocks.mirrorFile.mockResolvedValue({ path: 'c/x/bridge/b/u.png', url: 'https://signed.test/x', contentType: 'image/png', bytes: 3 })
    const out = await mirrorExternalMediaToStorage(SRC, { botId: 'b', channelId: 'c' })
    expect(mocks.mirrorFile).toHaveBeenCalledWith(SRC, { botId: 'b', channelId: 'c', ceiling: 1000 })
    expect(out.url).toBe('https://signed.test/x')
    expect(mocks.publicUrl).not.toHaveBeenCalled()
  })
})
