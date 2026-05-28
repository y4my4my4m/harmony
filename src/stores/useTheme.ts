import { defineStore } from 'pinia'
import { audioThemeService } from '@/services/AudioThemeService'
import type { AudioTheme, AudioAction, ThemePreferences } from '@/types'
import { debug } from '@/utils/debug'

interface ThemeState {
  // Audio themes
  audioThemes: AudioTheme[]
  currentAudioTheme: string
  audioVolume: number
  
  // State management
  isInitialized: boolean
  isLoading: boolean
  isPreloading: boolean
  preloadingTheme: string | null
  
  // Error handling
  lastError: string | null
  
  // Visual themes (future expansion)
  // visualTheme: string
  // customColors: Record<string, string>
}

/**
 * Professional Theme Store
 * 
 * Manages both audio and visual themes with:
 * - Hot swapping capabilities
 * - Intelligent caching
 * - Error recovery
 * - Performance monitoring
 * - Event-driven updates
 */
export const useThemeStore = defineStore('theme', {
  state: (): ThemeState => ({
    // Audio themes
    audioThemes: [],
    currentAudioTheme: 'default',
    audioVolume: 0.7,
    
    // State management
    isInitialized: false,
    isLoading: false,
    isPreloading: false,
    preloadingTheme: null,
    
    // Error handling
    lastError: null
  }),

  getters: {
    /**
     * Get current audio theme object
     */
    getCurrentAudioTheme: (state): AudioTheme | null => {
      return state.audioThemes.find(theme => theme.id === state.currentAudioTheme) || null
    },

    /**
     * Get built-in themes
     */
    getBuiltInThemes: (state): AudioTheme[] => {
      return state.audioThemes.filter(theme => theme.isBuiltIn)
    },

    /**
     * Get custom/user themes
     */
    getCustomThemes: (state): AudioTheme[] => {
      return state.audioThemes.filter(theme => !theme.isBuiltIn)
    },

    /**
     * Get themes grouped by category
     */
    getThemesByCategory: (state) => {
      return {
        builtin: state.audioThemes.filter(theme => theme.isBuiltIn),
        custom: state.audioThemes.filter(theme => !theme.isBuiltIn)
      }
    },

    /**
     * Check if system is ready for audio playback
     */
    isReady: (state): boolean => {
      return state.isInitialized && !state.isLoading && !state.lastError
    },

    /**
     * Get current system status
     */
    systemStatus: (state) => {
      if (state.lastError) return 'error'
      if (state.isLoading) return 'loading'
      if (state.isPreloading) return 'preloading'
      if (state.isInitialized) return 'ready'
      return 'uninitialized'
    }
  },

  actions: {
    /**
     * Initialize the professional theme system
     */
    async initialize(): Promise<void> {
      if (this.isInitialized) return
      
      this.isLoading = true
      this.lastError = null
      
      try {
        debug.log('🎨 Initializing professional theme system...')
        
        // Hydrate pack themes from IndexedDB before loading themes
        await audioThemeService.ensureCustomPacksLoaded()
        
        // Load available themes
        this.audioThemes = audioThemeService.getThemes()
        
        // Get current settings
        const currentTheme = audioThemeService.getCurrentTheme()
        this.currentAudioTheme = currentTheme?.id || 'default'
        this.audioVolume = audioThemeService.getVolume()
        
        // Setup event listeners
        this.setupEventListeners()
        
        // Preload current theme sounds
        await this.preloadCurrentTheme()
        
        this.isInitialized = true
        debug.log('✅ Theme system initialized successfully')
        
      } catch (error) {
        debug.error('❌ Failed to initialize theme system:', error)
        this.lastError = error instanceof Error ? error.message : 'Unknown initialization error'
        throw error
      } finally {
        this.isLoading = false
      }
    },

    /**
     * Setup event listeners for theme service
     */
    setupEventListeners(): void {
      audioThemeService.on('themeChanged', (event) => {
        this.currentAudioTheme = event.to
        debug.log(`🎵 Theme changed: ${event.from} → ${event.to}`)
      })

      audioThemeService.on('themePreloaded', (event) => {
        if (this.preloadingTheme === event.themeId) {
          this.isPreloading = false
          this.preloadingTheme = null
        }
        debug.log(`✅ Theme preloaded: ${event.theme.name}`)
      })

      audioThemeService.on('audioError', (event) => {
        debug.warn(`🔊 Audio playback error for ${event.action}:`, event.error)
      })

      audioThemeService.on('settingsChanged', (settings) => {
        this.audioVolume = settings.volume
      })

      audioThemeService.on('themeRegistered', () => {
        this.audioThemes = audioThemeService.getThemes()
      })
    },

    /**
     * Set audio theme with enhanced UX
     */
    async setAudioTheme(themeId: string): Promise<boolean> {
      if (themeId === this.currentAudioTheme) return true
      
      this.lastError = null
      
      try {
        debug.log(`🎵 Switching to theme: ${themeId}`)
        
        const success = await audioThemeService.setTheme(themeId)
        
        if (success) {
          this.currentAudioTheme = themeId
          
          // Play a sound from the newly selected theme (not default fallback)
          setTimeout(() => {
            audioThemeService.playThemeFeedbackSound(themeId)
          }, 100)
          
          debug.log(`✅ Successfully switched to theme: ${themeId}`)
        }
        
        return success
      } catch (error) {
        debug.error(`❌ Failed to set theme ${themeId}:`, error)
        this.lastError = error instanceof Error ? error.message : 'Theme switch failed'
        return false
      }
    },

    /**
     * Preload current theme
     */
    async preloadCurrentTheme(): Promise<void> {
      return this.preloadTheme(this.currentAudioTheme)
    },

    /**
     * Preload specific theme
     */
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

    /**
     * Set audio volume with validation
     */
    setAudioVolume(volume: number): void {
      const clampedVolume = Math.max(0, Math.min(1, volume))
      this.audioVolume = clampedVolume
      audioThemeService.setVolume(clampedVolume)
    },

    /**
     * Play audio for an action with error handling
     */
    async playAudio(action: AudioAction): Promise<void> {
      if (!this.isInitialized) {
        try {
          await this.initialize()
        } catch (error) {
          debug.warn(`🔊 Audio system failed to auto-initialize, skipping ${action}`)
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

    /**
     * Test audio for an action
     */
    async testAudio(action: AudioAction): Promise<void> {
      try {
        await audioThemeService.testAudio(action)
      } catch (error) {
        debug.warn(`Failed to test audio for ${action}:`, error)
        this.lastError = `Audio test failed: ${action}`
      }
    },

    /**
     * Refresh available themes
     */
    refreshThemes(): void {
      this.audioThemes = audioThemeService.getThemes()
    },

    /**
     * Register a custom theme
     */
    registerTheme(theme: AudioTheme): void {
      audioThemeService.registerTheme(theme)
      this.refreshThemes()
    },

    /**
     * Clear audio cache
     */
    clearAudioCache(): void {
      audioThemeService.clearCache()
      debug.log('🗑️ Audio cache cleared')
    },

    /**
     * Get cache information for debugging
     */
    getCacheInfo() {
      return audioThemeService.getCacheInfo()
    },

    /**
     * Clear last error
     */
    clearError(): void {
      this.lastError = null
    },

    /**
     * Get current preferences for export/backup
     */
    exportPreferences(): ThemePreferences {
      return {
        audio: {
          selectedTheme: this.currentAudioTheme,
          volume: this.audioVolume,
          lastUpdated: new Date().toISOString()
        }
      }
    },

    /**
     * Import preferences from backup
     */
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
        
        debug.log('✅ Theme preferences imported successfully')
      } catch (error) {
        debug.error('❌ Failed to import theme preferences:', error)
        this.lastError = 'Failed to import preferences'
      }
    },

    /**
     * Export a full audio theme pack as a ZIP archive (10MB max).
     */
    async exportThemePack(themeId: string): Promise<Blob> {
      return audioThemeService.exportThemePack(themeId)
    },

    /**
     * Import an audio theme pack from a ZIP archive and register as custom theme.
     */
    async importThemePack(zipData: ArrayBuffer | Blob): Promise<AudioTheme> {
      const theme = await audioThemeService.importThemePack(zipData)
      this.refreshThemes()
      return theme
    },

    /**
     * Reset to default settings
     */
    async resetToDefaults(): Promise<void> {
      try {
        await this.setAudioTheme('default')
        this.setAudioVolume(0.7)
        this.clearError()
        debug.log('✅ Theme settings reset to defaults')
      } catch (error) {
        debug.error('❌ Failed to reset settings:', error)
        this.lastError = 'Failed to reset settings'
      }
    }
  }
})
