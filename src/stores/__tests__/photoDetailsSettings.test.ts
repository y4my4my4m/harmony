import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { supabase } from '@/supabase'

// "Keep photo details by default": off when absent, signed out or unreadable; read from
// photo_details_settings; written by upsert; restored when the write fails.

const auth = reactive<{ session: { user: { id: string } } | null }>({ session: null })
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))

import { READY_TIMEOUT_MS, usePhotoDetailsSettingsStore } from '@/stores/photoDetailsSettings'

let row: { keep_by_default: boolean } | null
let readError: unknown
let writeError: unknown
const upserts: unknown[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  auth.session = null
  row = null
  readError = null
  writeError = null
  upserts.length = 0
  vi.mocked(supabase.from).mockImplementation(() => ({
    select: () => ({ maybeSingle: async () => ({ data: row, error: readError }) }),
    upsert: async (value: unknown, options: unknown) => {
      upserts.push([value, options])
      return { error: writeError }
    },
  }) as never)
})

describe('photoDetailsSettings', () => {
  it('is off signed out and for an account without a row', async () => {
    const store = usePhotoDetailsSettingsStore()
    expect(store.keepByDefault).toBe(false)
    auth.session = { user: { id: 'u1' } }
    await flushPromises()
    expect(store.keepByDefault).toBe(false)
    expect(store.loaded).toBe(true)
    expect(supabase.from).toHaveBeenCalledWith('photo_details_settings')
  })

  it('reads the stored choice and answers from the cache on the next load', async () => {
    row = { keep_by_default: true }
    auth.session = { user: { id: 'u1' } }
    const store = usePhotoDetailsSettingsStore()
    await flushPromises()
    expect(store.keepByDefault).toBe(true)

    setActivePinia(createPinia())
    readError = { message: 'offline' }
    const again = usePhotoDetailsSettingsStore()
    expect(again.keepByDefault).toBe(true)
    await flushPromises()
    expect(again.keepByDefault).toBe(true)
  })

  it('saves by upsert and restores the switch when the write fails', async () => {
    auth.session = { user: { id: 'u1' } }
    const store = usePhotoDetailsSettingsStore()
    await flushPromises()
    await store.setKeepByDefault(true)
    expect(store.keepByDefault).toBe(true)
    expect(upserts[0]).toEqual([expect.objectContaining({ keep_by_default: true }), { onConflict: 'user_id' }])

    writeError = { message: 'denied' }
    await expect(store.setKeepByDefault(false)).rejects.toEqual({ message: 'denied' })
    expect(store.keepByDefault).toBe(true)
  })

  it('starts from off for another account', async () => {
    row = { keep_by_default: true }
    auth.session = { user: { id: 'u1' } }
    const store = usePhotoDetailsSettingsStore()
    await flushPromises()
    row = null
    auth.session = { user: { id: 'u2' } }
    await flushPromises()
    expect(store.keepByDefault).toBe(false)
  })

  it('lets an attachment wait for a load in flight, never longer than READY_TIMEOUT_MS', async () => {
    // Stores of earlier tests still watch the shared auth object and fetch too.
    const answers: Array<(value: { data: { keep_by_default: boolean } | null; error: null }) => void> = []
    vi.mocked(supabase.from).mockImplementation(() => ({
      select: () => ({ maybeSingle: () => new Promise((resolve) => { answers.push(resolve) }) }),
    }) as never)
    auth.session = { user: { id: 'u1' } }
    const store = usePhotoDetailsSettingsStore()
    await flushPromises()
    let settled = false
    void store.ready().then(() => { settled = true })
    await flushPromises()
    expect(settled).toBe(false)
    answers.forEach((answer) => answer({ data: { keep_by_default: true }, error: null }))
    await flushPromises()
    expect(settled).toBe(true)
    expect(store.keepByDefault).toBe(true)

    vi.useFakeTimers()
    try {
      void store.reload()
      let timedOut = false
      void store.ready().then(() => { timedOut = true })
      await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS)
      expect(timedOut).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
