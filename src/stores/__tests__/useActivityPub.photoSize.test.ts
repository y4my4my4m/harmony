/**
 * Composer media rows record a photo's shown size from its header (utils/photoSize.ts),
 * and mark an animated one.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { supabase } from '@/supabase'

vi.mock('@/services/uploads/storageUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/uploads/storageUpload')>()),
  uploadStorageObject: async (...args: Parameters<typeof import('../../../tests/helpers/storageUploadMock').uploadThroughStorageMock>) =>
    (await import('../../../tests/helpers/storageUploadMock')).uploadThroughStorageMock(...args),
}))

vi.mock('@/services/userDataService', () => ({
  userDataService: { getCurrentUser: () => ({ id: 'me' }) },
}))

vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: async () => ({ isAuthenticated: true, authUser: { id: 'auth-me' }, profileId: 'me' }),
    getCurrentProfileId: async () => 'me',
  },
}))

import { useActivityPubStore } from '@/stores/useActivityPub'

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff]
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

const JPEG_3000x2000 = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xc0, ...u16(17), 8, ...u16(2000), ...u16(3000), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  0xff, 0xda, ...u16(2), 0xff, 0xd9,
])

function apng(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: number[]) => [...u32(data.length), ...ascii(type), ...data, 0, 0, 0, 0]
  return new Uint8Array([
    0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...u32(width), ...u32(height), 8, 6, 0, 0, 0]),
    ...chunk('acTL', [...u32(3), ...u32(0)]),
    ...chunk('IDAT', [0]),
    ...chunk('IEND', []),
  ])
}

describe('useActivityPub.uploadMediaAttachments photo size', () => {
  const upload = vi.fn()
  const getPublicUrl = vi.fn()

  beforeEach(() => {
    setActivePinia(createPinia())
    upload.mockReset().mockImplementation(async (path: string) => ({ data: { path }, error: null }))
    getPublicUrl.mockReset().mockImplementation((path: string) => ({ data: { publicUrl: `https://s.test/user_media/${path}` } }))
    ;(supabase.storage.from as any).mockReturnValue({ upload, getPublicUrl })
  })

  it('records the width and height of a photo', async () => {
    const file = new File([JPEG_3000x2000], 'harbour.jpg', { type: 'image/jpeg' })
    const [row] = await useActivityPubStore().uploadMediaAttachments([{ type: 'image', url: 'blob:a', file }])
    expect(row).toMatchObject({ type: 'Image', mediaType: 'image/jpeg', width: 3000, height: 2000 })
    expect(row).not.toHaveProperty('animated')
  })

  it('marks an animated PNG', async () => {
    const file = new File([apng(800, 600)], 'spin.png', { type: 'image/png' })
    const [row] = await useActivityPubStore().uploadMediaAttachments([{ type: 'image', url: 'blob:a', file }])
    expect(row).toMatchObject({ width: 800, height: 600, animated: true })
  })

  it('records no size for a file it cannot read', async () => {
    const file = new File(['not a photo'], 'notes.png', { type: 'image/png' })
    const [row] = await useActivityPubStore().uploadMediaAttachments([{ type: 'image', url: 'blob:a', file }])
    expect(row).not.toHaveProperty('width')
    expect(row).not.toHaveProperty('height')
  })
})
