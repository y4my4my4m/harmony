import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const prepare = vi.hoisted(() => vi.fn())
vi.mock('@/utils/imageResize', async importOriginal => ({
  ...(await importOriginal<typeof import('@/utils/imageResize')>()),
  prepareImageUpload: prepare,
}))

import { supabase } from '@/supabase'
import { waitForInitialLocale } from '@/i18n'
import { uploadAvatar } from '@/utils/fileUpload'
import { MAX_IMAGE_SOURCE_BYTES } from '@/utils/imageResize'
import { imageSourceError } from '@/utils/uploadValidation'

const MB = 1024 * 1024
const sized = (bytes: number, name: string, type: string) =>
  new File([new Uint8Array(bytes)], name, { type })

const upload = vi.fn()
const getBucket = vi.fn()

beforeAll(async () => {
  await waitForInitialLocale()
})

beforeEach(() => {
  prepare.mockReset()
  upload.mockReset().mockResolvedValue({ data: { path: 'uid/avatar-1.webp' }, error: null })
  getBucket.mockReset().mockResolvedValue({ data: null, error: { message: 'absent' } })
  const storage = supabase.storage as unknown as Record<string, unknown>
  storage.getBucket = getBucket
  vi.mocked(supabase.storage.from).mockReturnValue({
    upload,
    getPublicUrl: () => ({ data: { publicUrl: 'http://localhost:54321/storage/v1/object/public/avatars/uid/avatar-1.webp' } }),
  } as never)
})

describe('imageSourceError', () => {
  it('accepts files up to the source bound and names both sizes past it', () => {
    expect(imageSourceError(sized(MAX_IMAGE_SOURCE_BYTES, 'a.jpg', 'image/jpeg'))).toBeNull()
    const message = imageSourceError(sized(MAX_IMAGE_SOURCE_BYTES + 1, 'a.jpg', 'image/jpeg'))
    expect(message).toContain('25 MB')
    expect(message).not.toContain('files.imageTooLarge')
  })
})

describe('uploadImageObject', () => {
  it('accepts a photo over the bucket limit once shrinking brings it under', async () => {
    const photo = sized(8 * MB, 'phone.jpg', 'image/jpeg')
    const shrunk = sized(120_000, 'phone.webp', 'image/webp')
    prepare.mockResolvedValue({ file: shrunk, extension: 'webp', contentType: 'image/webp', reencoded: true })

    const result = await uploadAvatar(photo, 'uid')

    expect(result.success).toBe(true)
    expect(prepare).toHaveBeenCalledWith(photo, 'avatar')
    const [path, body, options] = upload.mock.calls[0]
    expect(path).toMatch(/^uid\/avatar-\d+\.webp$/)
    expect(body).toBe(shrunk)
    expect(options).toEqual({ contentType: 'image/webp', cacheControl: '31536000', upsert: false })
  })

  it('applies the bucket limit to what shrinking returns', async () => {
    const animated = sized(6 * MB, 'party.gif', 'image/gif')
    prepare.mockResolvedValue({ file: animated, extension: 'gif', contentType: 'image/gif', reencoded: false })

    const result = await uploadAvatar(animated, 'uid')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/too large .*5 MB/)
    expect(upload).not.toHaveBeenCalled()
  })

  it('refuses files past the source bound without decoding them', async () => {
    const result = await uploadAvatar(sized(MAX_IMAGE_SOURCE_BYTES + 1, 'raw.png', 'image/png'), 'uid')

    expect(result.success).toBe(false)
    expect(result.error).toContain('25 MB')
    expect(prepare).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })
})
