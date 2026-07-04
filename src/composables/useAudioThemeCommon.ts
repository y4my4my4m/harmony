import { ref, computed, onMounted, watch } from 'vue'
import { useThemeStore } from '@/stores/useTheme'
import { useNotificationStore } from '@/stores/useNotification'
import { debug } from '@/utils/debug'

/**
 * Shared composable for common audio theme functionality
 * Used by AudioThemePicker and AudioThemeManager to avoid code duplication
 */
export function useAudioThemeCommon() {
  const themeStore = useThemeStore()
  const notificationStore = useNotificationStore()

  // Local state
  const isLoading = ref(false)
  const pendingTheme = ref<string | null>(null)
  const localVolume = ref(70)
  const previousVolume = ref(70)
  const isTesting = ref(false)

  // Computed
  const themes = computed(() => themeStore.audioThemes)
  const currentTheme = computed(() => themeStore.currentAudioTheme)

  // Theme icon mapping (emojis for text display, e.g. AudioThemePicker)
  const getThemeIcon = (themeId: string): string => {
    const icons: Record<string, string> = {
      default: '🔊',
      futuristic: '🚀',
      neokobe: '🌃',
    }
    return icons[themeId] || '🎧'
  }

  // Theme icon names for Icon component (use with <Icon :name="getThemeIconName(id)" />)
  const getThemeIconName = (themeId: string): string => {
    const iconNames: Record<string, string> = {
      default: 'volume-2',
      futuristic: 'zap',
      neokobe: 'moon',
    }
    return iconNames[themeId] || 'headphones'
  }

  // Theme selection logic
  const selectTheme = async (themeId: string): Promise<boolean> => {
    if (themeId === currentTheme.value || isLoading.value) {
      return false
    }
    
    isLoading.value = true
    pendingTheme.value = themeId
    
    try {
      const success = await themeStore.setAudioTheme(themeId)
      if (success) {
        // const theme = themes.value.find(t => t.id === themeId)
        // notificationStore.showToast(
        //   'ui_success',
        //   'Audio Theme Changed',
        //   `Switched to ${theme?.name || themeId}`,
        //   2000
        // )
        return true
      } else {
        notificationStore.showToast(
          'ui_error',
          'Failed to Change Theme',
          'Could not switch to the selected audio theme',
          3000
        )
        return false
      }
    } catch (error) {
      debug.error('Failed to set theme:', error)
      notificationStore.showToast(
        'ui_error',
        'Theme Error',
        error instanceof Error ? error.message : 'Unknown error occurred',
        4000
      )
      return false
    } finally {
      isLoading.value = false
      pendingTheme.value = null
    }
  }

  // Test audio functionality
  const testCurrentTheme = async (): Promise<void> => {
    if (isTesting.value) return

    isTesting.value = true
    
    try {
      await themeStore.testAudio('mention')
      notificationStore.showToast(
        'ui_success',
        'Audio Test',
        'Theme test completed',
        1500
      )
    } catch (error) {
      debug.error('Failed to test theme:', error)
      notificationStore.showToast(
        'ui_error',
        'Audio Test Failed',
        'Could not play test sound',
        3000
      )
    } finally {
      isTesting.value = false
    }
  }

  const testTheme = async (themeId: string): Promise<void> => {
    if (isTesting.value) return
    
    isTesting.value = true
    
    try {
      // Temporarily switch to test theme
      const originalTheme = currentTheme.value
      if (themeId !== originalTheme) {
        await themeStore.setAudioTheme(themeId)
      }
      
      await themeStore.testAudio('mention')
      
      const theme = themes.value.find(t => t.id === themeId)
      notificationStore.showToast(
        'ui_success',
        'Theme Preview',
        `Testing ${theme?.name || themeId}`,
        1500
      )
      
      // Switch back if needed
      if (themeId !== originalTheme) {
        setTimeout(() => {
          themeStore.setAudioTheme(originalTheme)
        }, 100)
      }
    } catch (error) {
      debug.error('Failed to test theme:', error)
      notificationStore.showToast(
        'ui_error',
        'Test Failed',
        'Could not preview theme audio',
        3000
      )
    } finally {
      isTesting.value = false
    }
  }

  // Volume control logic
  const onVolumeChange = (): void => {
    themeStore.setAudioVolume(localVolume.value / 100)
  }

  const toggleMute = (): void => {
    if (localVolume.value === 0) {
      localVolume.value = previousVolume.value || 50
    } else {
      previousVolume.value = localVolume.value
      localVolume.value = 0
    }
    onVolumeChange()
  }

  const setVolumePreset = (value: number): void => {
    localVolume.value = value
    onVolumeChange()
  }

  const isVolumePresetActive = (value: number): boolean => {
    return Math.abs(localVolume.value - value) < 5
  }

  // Theme loading status
  const isThemeLoading = (themeId?: string): boolean => {
    if (themeId) {
      return isLoading.value && pendingTheme.value === themeId
    }
    return isLoading.value
  }

  // Cache management
  const clearCache = (): void => {
    try {
      themeStore.clearAudioCache()
      notificationStore.showToast(
        'ui_success',
        'Cache Cleared',
        'Audio cache has been cleared successfully',
        2000
      )
    } catch (error) {
      debug.error('Failed to clear cache:', error)
      notificationStore.showToast(
        'ui_error',
        'Clear Cache Failed',
        'Could not clear audio cache',
        3000
      )
    }
  }

  // Preload functionality
  const preloadTheme = async (themeId: string): Promise<void> => {
    if (themeStore.preloadingTheme === themeId) return
    
    try {
      await themeStore.preloadTheme(themeId)
    } catch (error) {
      debug.warn('Failed to preload theme:', error)
    }
  }

  // Settings management
  const exportThemeSettings = (): void => {
    try {
      const settings = themeStore.exportPreferences()
      const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `harmony-theme-settings-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      
      notificationStore.showToast(
        'ui_success',
        'Settings Exported',
        'Audio theme settings have been downloaded',
        2000
      )
    } catch (error) {
      debug.error('Failed to export settings:', error)
      notificationStore.showToast(
        'ui_error',
        'Export Failed',
        'Could not export theme settings',
        3000
      )
    }
  }

  const importThemeSettings = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) {
        const reader = new FileReader()
        reader.onload = (e) => {
          try {
            const settings = JSON.parse(e.target?.result as string)
            themeStore.importPreferences(settings)
            notificationStore.showToast(
              'ui_success',
              'Settings Imported',
              'Audio theme settings have been restored',
              2000
            )
          } catch (error) {
            debug.error('Failed to import settings:', error)
            notificationStore.showToast(
              'ui_error',
              'Import Failed',
              'Could not import theme settings. Please check the file format.',
              3000
            )
          }
        }
        reader.readAsText(file)
      }
    }
    input.click()
  }

  const resetToDefaults = async (): Promise<void> => {
    try {
      await themeStore.resetToDefaults()
      localVolume.value = 70
      notificationStore.showToast(
        'ui_success',
        'Settings Reset',
        'Audio theme settings have been reset to defaults',
        2000
      )
    } catch (error) {
      debug.error('Failed to reset settings:', error)
      notificationStore.showToast(
        'ui_error',
        'Reset Failed',
        'Could not reset theme settings',
        3000
      )
    }
  }

  // Initialize the composable
  const initialize = async (): Promise<void> => {
    if (!themeStore.isInitialized) {
      await themeStore.initialize()
    }
    localVolume.value = Math.round(themeStore.audioVolume * 100)
  }

  // Watch for volume changes from store
  watch(() => themeStore.audioVolume, (newVolume) => {
    localVolume.value = Math.round(newVolume * 100)
  })

  // Initialize on mount if needed
  onMounted(() => {
    initialize()
  })

  return {
    // State
    isLoading,
    pendingTheme,
    localVolume,
    previousVolume,
    isTesting,
    
    // Computed
    themes,
    currentTheme,
    
    // Methods
    getThemeIcon,
    getThemeIconName,
    selectTheme,
    testCurrentTheme,
    testTheme,
    onVolumeChange,
    toggleMute,
    setVolumePreset,
    isVolumePresetActive,
    isThemeLoading,
    clearCache,
    preloadTheme,
    exportThemeSettings,
    importThemeSettings,
    resetToDefaults,
    initialize
  }
}
