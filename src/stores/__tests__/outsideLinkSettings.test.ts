import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { supabase } from '@/supabase'

// Outside-link choices: a change made while a fetch is in flight survives the fetch's answer,
// in the store and in the cache; a field nobody changed takes the database's value.

const auth = reactive<{ session: { user: { id: string } } | null }>({ session: { user: { id: 'u1' } } })
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))

import { useOutsideLinkSettingsStore } from '@/stores/outsideLinkSettings'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

let settingsReads: Deferred<{ data: { ask_every_link: boolean } | null; error: null }>[]
let hostReads: Deferred<{ data: { host: string }[]; error: null }>[]

function answer(index: number, ask: boolean, hosts: string[]) {
  settingsReads[index].resolve({ data: { ask_every_link: ask }, error: null })
  hostReads[index].resolve({ data: hosts.map((host) => ({ host })), error: null })
}

function cached() {
  return JSON.parse(localStorage.getItem('harmony_outside_links:u1') ?? 'null')
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  auth.session = { user: { id: 'u1' } }
  settingsReads = []
  hostReads = []
  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    if (table === 'outside_link_settings') {
      return {
        select: () => ({
          maybeSingle: () => {
            const read = deferred<{ data: { ask_every_link: boolean } | null; error: null }>()
            settingsReads.push(read)
            return read.promise
          },
        }),
        upsert: async () => ({ error: null }),
      }
    }
    return {
      select: () => ({
        order: () => {
          const read = deferred<{ data: { host: string }[]; error: null }>()
          hostReads.push(read)
          return read.promise
        },
      }),
      insert: async () => ({ error: null }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    }
  }) as never)
})

describe('outsideLinkSettings load against local changes', () => {
  it('keeps ask-every-link switched on while a reload was in flight', async () => {
    const store = useOutsideLinkSettingsStore()
    answer(0, false, [])
    await flushPromises()

    const reload = store.reload()
    await store.setAskEveryLink(true)
    answer(1, false, [])
    await reload

    expect(store.askEveryLink).toBe(true)
    expect(cached().askEveryLink).toBe(true)
  })

  it('keeps a host trusted and one untrusted while a reload was in flight', async () => {
    const store = useOutsideLinkSettingsStore()
    answer(0, false, ['old.example'])
    await flushPromises()

    const reload = store.reload()
    await store.trust('new.example')
    await store.untrust('old.example')
    answer(1, false, ['old.example'])
    await reload

    expect([...store.trustedHosts]).toEqual(['new.example'])
    expect(cached().trustedHosts).toEqual(['new.example'])
  })

  it('takes the database value for a field nobody changed', async () => {
    const store = useOutsideLinkSettingsStore()
    answer(0, false, [])
    await flushPromises()

    const reload = store.reload()
    await store.trust('new.example')
    answer(1, true, ['new.example', 'other.example'])
    await reload

    expect(store.askEveryLink).toBe(true)
    expect([...store.trustedHosts]).toEqual(['new.example'])
  })
})
