/**
 * Post media: the composer's "Keep photo details" decides whether the upload keeps the photo's
 * metadata; a bare File (no composer row) is stripped.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { supabase } from '@/supabase'

const uploads = vi.hoisted(() => [] as Array<{ path: string; file: File; options: { keepMetadata?: boolean } }>)
const copies = vi.hoisted(() => [] as string[])
const fetched = vi.hoisted(() => [] as string[])
vi.mock('@/services/drive/driveService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/drive/driveService')>()),
  copyDriveFileToPostMedia: async (path: string) => {
    copies.push(path)
    return `https://s.test/copy/${path}`
  },
}))
vi.mock('@/services/privateMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/privateMedia')>()),
  storedObjectSource: (path: string, name: string, type: string) => ({
    name,
    size: 1,
    fetch: async () => {
      fetched.push(path)
      return new File(['bytes'], name, { type })
    },
  }),
}))
vi.mock('@/services/uploads/storageUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/uploads/storageUpload')>()),
  uploadStorageObject: async (_bucket: string, path: string, file: File, options: { keepMetadata?: boolean }) => {
    uploads.push({ path, file, options })
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
    copies.length = 0
    fetched.length = 0
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

  it('copies a Drive photo without details or kept, and strips one that carries details not kept', async () => {
    const drive = (name: string, extra: Record<string, unknown>) =>
      ({ type: 'image', url: `blob:${name}`, filename: name, mime_type: 'image/jpeg', size: 10, drivePath: `u/uid/${name}`, ...extra })
    const rows = await useActivityPubStore().uploadMediaAttachments([
      drive('clean.jpg', { photoDetails: { container: null, location: false, details: false } }),
      drive('kept.jpg', { photoDetails: { container: null, location: true, details: true }, keepDetails: true }),
      drive('gps.jpg', { photoDetails: { container: null, location: true, details: true }, keepDetails: false }),
    ])
    expect(copies.sort()).toEqual(['u/uid/clean.jpg', 'u/uid/kept.jpg'])
    expect(fetched).toEqual(['u/uid/gps.jpg'])
    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toMatchObject({ options: { keepMetadata: false } })
    expect(uploads[0].file.name).toBe('gps.jpg')
    expect(rows.map((r: { url: string }) => r.url.includes('/copy/'))).toEqual([true, true, false])
  })
})
