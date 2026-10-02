import { beforeEach, describe, expect, it, vi } from 'vitest'
import { supabase } from '@/supabase'
import { validateImageUpload } from '@/utils/uploadValidation'

// message_media lists `video/*` and `audio/*`; storage-api matches them as wildcards.
describe('validateImageUpload against message_media', () => {
  beforeEach(() => {
    vi.mocked(supabase.storage as any).getBucket = vi.fn(async () => ({
      data: { file_size_limit: 1024, allowed_mime_types: ['image/png', 'video/*', 'audio/*'] },
      error: null,
    }))
  })

  it('admits wildcard types and refuses others', async () => {
    const file = (type: string, size = 10) => new File([new Uint8Array(size)], 'f', { type })
    await expect(validateImageUpload(file('video/mp4'), 'message_media')).resolves.toBeNull()
    await expect(validateImageUpload(file('audio/webm;codecs=opus'), 'message_media')).resolves.toBeNull()
    await expect(validateImageUpload(file('text/html'), 'message_media')).resolves.toMatch(/isn't allowed/)
    await expect(validateImageUpload(file('image/png', 4096), 'message_media')).resolves.toMatch(/too large/)
  })
})
