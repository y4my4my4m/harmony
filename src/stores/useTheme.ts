import { defineStore } from 'pinia'
import { audioThemeService } from '@/services/AudioThemeService'
import type { AudioTheme, AudioAction, ThemePreferences } from '@/types'
import { debug } from '@/utils/debug'

interface ThemeState {
  audioThemes: AudioTheme[]
  currentAudioTheme: string
  audioVolume: number
  isInitialized: boolean
  isLoading: boolean
  isPreloading: boolean
  preloadingTheme: string | null
  lastError: string | null
}

export const useThemeStore = defineStore('theme', {
  state: (): ThemeState => ({
    audioThemes: [],
    currentAudioTheme: 'default',
    audioVolume: 1.0,
    isInitialized: false,
    isLoading: false,
    isPreloading: false,
    preloadingTheme: null,
    lastError: null
  }),

  getters: {
    getCurrentAudioTheme: (state): AudioTheme | null => {
      return state.audioThemes.find(theme => theme.id === state.currentAudioTheme) || null
    },

    getBuiltInThemes: (state): AudioTheme[] => {
      return state.audioThemes.filter(theme => theme.isBuiltIn)
    },

    getCustomThemes: (state): AudioTheme[] => {
      return state.audioThemes.filter(theme => !theme.isBuiltIn)
    },

    getThemesByCategory: (state) => {
      return {
        builtin: state.audioThemes.filter(theme => theme.isBuiltIn),
        custom: state.audioThemes.filter(theme => !theme.isBuiltIn)
      }
    },

    isReady: (state): boolean => {
      return state.isInitialized && !state.isLoading && !state.lastError
    },

    systemStatus: (state) => {
      if (state.lastError) return 'error'
      if (state.isLoading) return 'loading'
      if (state.isPreloading) return 'preloading'
      if (state.isInitialized) return 'ready'
      return 'uninitialized'
    }
  },

  actions: {
    async initialize(): Promise<void> {
      if (this.isInitialized) return

      this.isLoading = true
      this.lastError = null

      try {
        debug.log('Initializing professional theme system...')

        await audioThemeService.ensureCustomPacksLoaded()
        this.audioThemes = audioThemeService.getThemes()

        const currentTheme = audioThemeService.getCurrentTheme()
        this.currentAudioTheme = currentTheme?.id || 'default'
        this.audioVolume = audioThemeService.getVolume()

        this.setupEventListeners()
        await this.preloadCurrentTheme()

        this.isInitialized = true
        debug.log('Theme system initialized successfully')
      } catch (error) {
        debug.error('Failed to initialize theme system:', error)
        this.lastError = error instanceof Error ? error.message : 'Unknown initialization error'
        throw error
      } finally {
        this.isLoading = false
      }
    },

    setupEventListeners(): void {
      audioThemeService.on('themeChanged', (event) => {
        this.currentAudioTheme = event.to
        debug.log(`Theme changed: ${event.from} → ${event.to}`)
      })

      audioThemeService.on('themePreloaded', (event) => {
        if (this.preloadingTheme === event.themeId) {
          this.isPreloading = false
          this.preloadingTheme = null
        }
        debug.log(`Theme preloaded: ${event.theme.name}`)
      })

      audioThemeService.on('audioError', (event) => {
        debug.warn(`Audio playback error for ${event.action}:`, event.error)
      })

      audioThemeService.on('settingsChanged', (settings) => {
        this.audioVolume = settings.volume
      })

      audioThemeService.on('themeRegistered', () => {
        this.audioThemes = audioThemeService.getThemes()
      })
    },

    async setAudioTheme(themeId: string): Promise<boolean> {
      if (themeId === this.currentAudioTheme) return true

      this.lastError = null

      try {
        debug.log(`Switching to theme: ${themeId}`)

        const success = await audioThemeService.setTheme(themeId)

        if (success) {
          this.currentAudioTheme = themeId
          setTimeout(() => {
            audioThemeService.playThemeFeedbackSound(themeId)
          }, 100)
          debug.log(`Successfully switched to theme: ${themeId}`)
        }

        return success
      } catch (error) {
        debug.error(`Failed to set theme ${themeId}:`, error)
        this.lastError = error instanceof Error ? error.message : 'Theme switch failed'
        return false
      }
    },

    async preloadCurrentTheme(): Promise<void> {
      return this.preloadTheme(this.currentAudioTheme)
    },

    async preloadTheme(themeId: string): Promise<void> {
      if (this.isPreloading && this.preloadingTheme === themeId) return

      this.isPreloading = true
      this.preloadingTheme = themeId

      try {
        await audioThemeService.preloadTheme(themeId)
      } catch (error) {
        debug.warn(`Failed to preload theme ${themeId}:`, error)
        this.lastError = `Preload failed: ${themeId}`
      } finally {
        if (this.preloadingTheme === themeId) {
          this.isPreloading = false
          this.preloadingTheme = null
        }
      }
    },

    setAudioVolume(volume: number): void {
      const clampedVolume = Math.max(0, Math.min(1, volume))
      this.audioVolume = clampedVolume
      audioThemeService.setVolume(clampedVolume)
    },

    async playAudio(action: AudioAction): Promise<void> {
      if (!this.isInitialized) {
        try {
          await this.initialize()
        } catch (error) {
          debug.warn(`Audio system failed to auto-initialize, skipping ${action}`)
          return
        }
      }

      try {
        await audioThemeService.playAudio(action)
      } catch (error) {
        debug.warn(`Failed to play audio for ${action}:`, error)
        this.lastError = `Audio playback failed: ${action}`
      }
    },

    async testAudio(action: AudioAction): Promise<void> {
      try {
        await audioThemeService.testAudio(action)
      } catch (error) {
        debug.warn(`Failed to test audio for ${action}:`, error)
        this.lastError = `Audio test failed: ${action}`
      }
    },

    refreshThemes(): void {
      this.audioThemes = audioThemeService.getThemes()
    },

    registerTheme(theme: AudioTheme): void {
      audioThemeService.registerTheme(theme)
      this.refreshThemes()
    },

    clearAudioCache(): void {
      audioThemeService.clearCache()
      debug.log('Audio cache cleared')
    },

    getCacheInfo() {
      return audioThemeService.getCacheInfo()
    },

    clearError(): void {
      this.lastError = null
    },

    exportPreferences(): ThemePreferences {
      return {
        audio: {
          selectedTheme: this.currentAudioTheme,
          volume: this.audioVolume,
          lastUpdated: new Date().toISOString()
        }
      }
    },

    async importPreferences(preferences: ThemePreferences): Promise<void> {
      if (!preferences.audio) return

      const { selectedTheme, volume } = preferences.audio

      try {
        if (selectedTheme && selectedTheme !== this.currentAudioTheme) {
          await this.setAudioTheme(selectedTheme)
        }

        if (typeof volume === 'number' && volume !== this.audioVolume) {
          this.setAudioVolume(volume)
        }

        debug.log('Theme preferences imported successfully')
      } catch (error) {
        debug.error('Failed to import theme preferences:', error)
        this.lastError = 'Failed to import preferences'
      }
    },

    async exportThemePack(themeId: string): Promise<Blob> {
      return audioThemeService.exportThemePack(themeId)
    },

    async importThemePack(zipData: ArrayBuffer | Blob): Promise<AudioTheme> {
      const theme = await audioThemeService.importThemePack(zipData)
      this.refreshThemes()
      return theme
    },

    async resetToDefaults(): Promise<void> {
      try {
        await this.setAudioTheme('default')
        this.setAudioVolume(0.7)
        this.clearError()
        debug.log('Theme settings reset to defaults')
      } catch (error) {
        debug.error('Failed to reset settings:', error)
        this.lastError = 'Failed to reset settings'
      }
    }
  }
})
