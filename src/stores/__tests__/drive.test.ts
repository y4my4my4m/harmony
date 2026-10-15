// The Drive list shows only the place it is titled with: switching places drops the old
// place's files while the new list loads, and a late answer for an old place is ignored.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const pending: Array<{ view: string; resolve: (value: unknown) => void }> = []

vi.mock('@/services/drive/driveService', () => ({
  listDriveFiles: vi.fn((opts: { view: string }) => new Promise((resolve) => pending.push({ view: opts.view, resolve }))),
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: null }) }))
vi.mock('@/services/messageMediaUpload', () => ({ startMessageMediaUpload: vi.fn() }))
vi.mock('@/services/privateMedia', () => ({ messageMediaPath: vi.fn() }))
vi.mock('@/composables/useDriveUsage', () => ({ refreshDriveUsage: vi.fn() }))

import { useDriveStore } from '../drive'

const entry = (id: string) => ({ file: { id, name: `${id}.txt` }, owner: null })

beforeEach(() => {
  setActivePinia(createPinia())
  pending.length = 0
})

describe('drive store places', () => {
  it('clears the old place while the new one loads, and ignores the old answer', async () => {
    const drive = useDriveStore()
    drive.open({ view: 'folder', id: null })
    pending[0].resolve({ entries: [entry('a'), entry('b')], total: 2 })
    await vi.waitFor(() => expect(drive.entries).toHaveLength(2))

    drive.open({ view: 'server', id: 's1' })
    drive.open({ view: 'ephemeral', id: null })
    expect(drive.entries).toEqual([])
    expect(drive.loading).toBe(true)

    pending[2].resolve({ entries: [], total: 0 })
    pending[1].resolve({ entries: [entry('a')], total: 1 })
    await vi.waitFor(() => expect(drive.loading).toBe(false))
    expect(drive.entries).toEqual([])
  })

  it('keeps the files on a reload of the same place', async () => {
    const drive = useDriveStore()
    drive.open({ view: 'trash', id: null })
    pending[0].resolve({ entries: [entry('t')], total: 1 })
    await vi.waitFor(() => expect(drive.entries).toHaveLength(1))
    drive.open({ view: 'trash', id: null })
    expect(drive.entries).toHaveLength(1)
  })
})
