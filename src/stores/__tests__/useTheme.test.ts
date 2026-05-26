import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('@/services/AudioThemeService', () => ({
  audioThemeService: {
    getThemes: vi.fn(() => [
      { id: 'harmony', name: 'Harmony', isBuiltIn: true },
      { id: 'retro', name: 'Retro', isBuiltIn: true },
      { id: 'custom1', name: 'My Theme', isBuiltIn: false },
    ]),
    getCurrentTheme: vi.fn(() => ({ id: 'harmony', name: 'Harmony' })),
    getVolume: vi.fn(() => 0.7),
    setTheme: vi.fn().mockResolvedValue(true),
    setVolume: vi.fn(),
    preloadTheme: vi.fn().mockResolvedValue(undefined),
    playAudio: vi.fn().mockResolvedValue(undefined),
    testAudio: vi.fn().mockResolvedValue(undefined),
    registerTheme: vi.fn(),
    clearCache: vi.fn(),
    getCacheInfo: vi.fn(() => ({ size: 0 })),
    on: vi.fn(),
    // Added when the store gained IndexedDB-backed custom packs - the
    // store's `initialize()` awaits this before calling `getThemes()`,
    // so it must exist or every initialize-dependent test throws
    // "audioThemeService.ensureCustomPacksLoaded is not a function".
    ensureCustomPacksLoaded: vi.fn().mockResolvedValue(undefined),
  },
}))

import { useThemeStore } from '@/stores/useTheme'

describe('useThemeStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('initializes with default state', () => {
    const store = useThemeStore()
    expect(store.currentAudioTheme).toBe('harmony')
    expect(store.audioVolume).toBe(0.7)
    expect(store.isInitialized).toBe(false)
    expect(store.isLoading).toBe(false)
    expect(store.lastError).toBeNull()
  })

  describe('getters', () => {
    it('getCurrentAudioTheme returns null when themes not loaded', () => {
      const store = useThemeStore()
      expect(store.getCurrentAudioTheme).toBeNull()
    })

    it('systemStatus returns uninitialized initially', () => {
      const store = useThemeStore()
      expect(store.systemStatus).toBe('uninitialized')
    })

    it('systemStatus returns loading when loading', () => {
      const store = useThemeStore()
      store.isLoading = true
      expect(store.systemStatus).toBe('loading')
    })

    it('systemStatus returns error when error exists', () => {
      const store = useThemeStore()
      store.lastError = 'some error'
      expect(store.systemStatus).toBe('error')
    })

    it('isReady returns true when initialized and no errors', () => {
      const store = useThemeStore()
      store.isInitialized = true
      store.isLoading = false
      store.lastError = null
      expect(store.isReady).toBe(true)
    })

    it('getBuiltInThemes filters correctly after loading', async () => {
      const store = useThemeStore()
      await store.initialize()
      expect(store.getBuiltInThemes.length).toBe(2)
    })

    it('getCustomThemes filters correctly after loading', async () => {
      const store = useThemeStore()
      await store.initialize()
      expect(store.getCustomThemes.length).toBe(1)
    })
  })

  describe('actions', () => {
    it('initialize loads themes and marks as initialized', async () => {
      const store = useThemeStore()
      await store.initialize()
      expect(store.isInitialized).toBe(true)
      expect(store.audioThemes.length).toBe(3)
      expect(store.isLoading).toBe(false)
    })

    it('initialize is idempotent', async () => {
      const store = useThemeStore()
      await store.initialize()
      await store.initialize()
      expect(store.isInitialized).toBe(true)
    })

    it('setAudioVolume clamps value between 0 and 1', () => {
      const store = useThemeStore()
      store.setAudioVolume(1.5)
      expect(store.audioVolume).toBe(1)
      store.setAudioVolume(-0.5)
      expect(store.audioVolume).toBe(0)
      store.setAudioVolume(0.5)
      expect(store.audioVolume).toBe(0.5)
    })

    it('clearError resets lastError', () => {
      const store = useThemeStore()
      store.lastError = 'error'
      store.clearError()
      expect(store.lastError).toBeNull()
    })

    it('exportPreferences returns current state', () => {
      const store = useThemeStore()
      const prefs = store.exportPreferences()
      expect(prefs.audio.selectedTheme).toBe('harmony')
      expect(prefs.audio.volume).toBe(0.7)
    })
  })
})
