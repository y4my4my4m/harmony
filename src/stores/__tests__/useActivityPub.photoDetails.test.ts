/**
 * Post media: the composer's "Keep photo details" decides whether the upload keeps the photo's
 * metadata; a bare File (no composer row) is stripped.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { supabase } from '@/supabase'

const uploads = vi.hoisted(() => [] as Array<{ path: string; options: { keepMetadata?: boolean } }>)
vi.mock('@/services/uploads/storageUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/uploads/storageUpload')>()),
  uploadStorageObject: async (_bucket: string, path: string, _file: File, options: { keepMetadata?: boolean }) => {
    uploads.push({ path, options })
    return { data: { path }, error: null }
  },
}))
vi.mock('@/services/userDataService', () => ({ userDataService: { getCurrentUser: () => ({ id: 'me' }) } }))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: async () => ({ isAuthenticated: true, authUser: { id: 'auth-me' }, profileId: 'me' }),
    getCurrentProfileId: async () => 'me',
  },
}))

import { useActivityPubStore } from '@/stores/useActivityPub'

describe('useActivityPub.uploadMediaAttachments photo details', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    uploads.length = 0
    ;(supabase.storage.from as any).mockReturnValue({ getPublicUrl: (path: string) => ({ data: { publicUrl: `https://s.test/${path}` } }) })
  })

  it('strips unless the row keeps its details', async () => {
    const file = () => new File(['x'], 'a.jpg', { type: 'image/jpeg' })
    await useActivityPubStore().uploadMediaAttachments([
      { type: 'image', url: 'blob:a', file: file() },
      { type: 'image', url: 'blob:b', file: file(), keepDetails: true },
      { type: 'image', url: 'blob:c', file: file(), keepDetails: false },
      file(),
    ])
    expect(uploads.map((u) => u.options.keepMetadata)).toEqual([false, true, false, false])
  })
})
