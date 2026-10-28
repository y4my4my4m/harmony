// Drive uploads keep photo details only for the files chosen in the upload review.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const started = vi.hoisted(() => [] as Array<{ name: string; keepMetadata?: boolean }>)
vi.mock('@/services/drive/driveService', () => ({ listDriveFiles: vi.fn(async () => ({ entries: [], total: 0 })) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'uid-1' } } }) }))
vi.mock('@/services/messageMediaUpload', () => ({
  startMessageMediaUpload: vi.fn((_path: string, file: File, options: { keepMetadata?: boolean }) => {
    started.push({ name: file.name, keepMetadata: options.keepMetadata })
    return { path: _path, state: {}, result: Promise.resolve({ path: _path, url: '' }), abort: vi.fn() }
  }),
}))
vi.mock('@/services/privateMedia', () => ({ messageMediaPath: (room: string, uid: string, name: string) => `${room}/${uid}/${name}` }))
vi.mock('@/composables/useDriveUsage', () => ({ refreshDriveUsage: vi.fn() }))

import { useDriveStore } from '../drive'

beforeEach(() => {
  setActivePinia(createPinia())
  started.length = 0
})

describe('drive uploads and photo details', () => {
  it('keeps metadata only for the files in keepDetails', () => {
    const a = new File(['a'], 'a.jpg', { type: 'image/jpeg' })
    const b = new File(['b'], 'b.jpg', { type: 'image/jpeg' })
    const c = new File(['c'], 'c.txt', { type: 'text/plain' })
    useDriveStore().uploadFiles([a, b, c], null, new Set([b]))
    expect(started).toEqual([
      { name: 'a.jpg', keepMetadata: false },
      { name: 'b.jpg', keepMetadata: true },
      { name: 'c.txt', keepMetadata: false },
    ])
  })

  it('strips every file without a review', () => {
    useDriveStore().uploadFiles([new File(['a'], 'a.jpg', { type: 'image/jpeg' })], null)
    expect(started).toEqual([{ name: 'a.jpg', keepMetadata: false }])
  })
})
