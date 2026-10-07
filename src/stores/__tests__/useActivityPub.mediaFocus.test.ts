/**
 * Composer media rows: a new upload stores alt text and the focal point as
 * Mastodon meta.focus; an attachment already in storage (editing a post) is
 * kept as stored, with the edited alt text and focus applied.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { supabase } from '@/supabase'

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

describe('useActivityPub.uploadMediaAttachments', () => {
  const upload = vi.fn()
  const getPublicUrl = vi.fn()

  beforeEach(() => {
    setActivePinia(createPinia())
    upload.mockReset().mockImplementation(async (path: string) => ({ data: { path }, error: null }))
    getPublicUrl.mockReset().mockImplementation((path: string) => ({ data: { publicUrl: `https://s.test/user_media/${path}` } }))
    ;(supabase.storage.from as any).mockReturnValue({ upload, getPublicUrl })
  })

  it('stores the focus as meta.focus next to the description', async () => {
    const file = new File(['x'], 'crop.webp', { type: 'image/webp' })
    const [row] = await useActivityPubStore().uploadMediaAttachments([
      { type: 'image', url: 'blob:local', file, description: ' A heron ', focus: { x: 0.25, y: -0.5 } },
    ])
    expect(upload).toHaveBeenCalledTimes(1)
    expect(row).toEqual({
      type: 'Image',
      url: expect.stringMatching(/^https:\/\/s\.test\/user_media\/auth-me\/posts\/.+\.webp$/),
      mediaType: 'image/webp',
      name: 'crop.webp',
      description: 'A heron',
      meta: { focus: { x: 0.25, y: -0.5 } },
    })
  })

  it('omits a centred focus', async () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    const [row] = await useActivityPubStore().uploadMediaAttachments([{ type: 'image', url: 'blob:a', file, focus: { x: 0, y: 0 } }])
    expect(row).not.toHaveProperty('meta')
  })

  it('keeps a stored attachment without uploading it again', async () => {
    const stored = { type: 'Image', url: 'https://s.test/user_media/me/posts/1.png', mediaType: 'image/png', name: 'IMG.png', description: 'old', meta: { focus: { x: 1, y: 1 } } }
    const [row] = await useActivityPubStore().uploadMediaAttachments([
      { type: 'image', url: stored.url, stored, description: 'new alt', focus: { x: -0.5, y: 0.5 } },
    ])
    expect(upload).not.toHaveBeenCalled()
    expect(row).toEqual({ ...stored, description: 'new alt', meta: { focus: { x: -0.5, y: 0.5 } } })
  })
})
