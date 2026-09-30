import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const store = new Map<string, string>()
vi.mock('@/utils/userScopedStorage', () => ({
  userStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
  },
}))

import { useSpatialAudioStore } from '../spatialAudio'

describe('spatial audio default', () => {
  beforeEach(() => {
    store.clear()
    setActivePinia(createPinia())
  })

  it('is off for a user who never enabled it', () => {
    expect(useSpatialAudioStore().settings.enabled).toBe(false)
  })

  it('restores a saved choice', () => {
    store.set('spatial-audio-enabled', 'true')
    expect(useSpatialAudioStore().settings.enabled).toBe(true)
  })
})
