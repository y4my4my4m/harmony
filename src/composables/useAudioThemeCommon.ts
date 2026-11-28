import { ref, computed, onMounted, watch } from 'vue'
import { useThemeStore } from '@/stores/useTheme'
import { useNotificationStore } from '@/stores/useNotification'
import { debug } from '@/utils/debug'
import { i18n } from '@/i18n'

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
  const localVolume = ref(100)
  const previousVolume = ref(100)
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
      skyglass: '🫧',
      lattice: '💠',
      flux: '🌊',
    }
    return icons[themeId] || '🎧'
  }

  // Theme icon names for Icon component (use with <Icon :name="getThemeIconName(id)" />)
  const getThemeIconName = (themeId: string): string => {
    const iconNames: Record<string, string> = {
      default: 'volume-2',
      futuristic: 'zap',
      neokobe: 'moon',
      skyglass: 'sparkles',
      lattice: 'grid',
      flux: 'waves',
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
          i18n.global.t('settings.audio.themes.toasts.changeFailed.title'),
          i18n.global.t('settings.audio.themes.toasts.changeFailed.message'),
          3000
        )
        return false
      }
    } catch (error) {
      debug.error('Failed to set theme:', error)
      notificationStore.showToast(
        'ui_error',
        i18n.global.t('settings.audio.themes.toasts.error.title'),
        error instanceof Error ? error.message : i18n.global.t('settings.audio.themes.toasts.error.message'),
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
        i18n.global.t('settings.audio.themes.toasts.testDone.title'),
        i18n.global.t('settings.audio.themes.toasts.testDone.message'),
        1500
      )
    } catch (error) {
      debug.error('Failed to test theme:', error)
      notificationStore.showToast(
        'ui_error',
        i18n.global.t('settings.audio.themes.toasts.testFailed.title'),
        i18n.global.t('settings.audio.themes.toasts.testFailed.message'),
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
        i18n.global.t('settings.audio.themes.toasts.preview.title'),
        i18n.global.t('settings.audio.themes.toasts.preview.message', { theme: theme?.name || themeId }),
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
        i18n.global.t('settings.audio.themes.toasts.previewFailed.title'),
        i18n.global.t('settings.audio.themes.toasts.previewFailed.message'),
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
        i18n.global.t('settings.audio.themes.toasts.cacheCleared.title'),
        i18n.global.t('settings.audio.themes.toasts.cacheCleared.message'),
        2000
      )
    } catch (error) {
      debug.error('Failed to clear cache:', error)
      notificationStore.showToast(
        'ui_error',
        i18n.global.t('settings.audio.themes.toasts.cacheClearFailed.title'),
        i18n.global.t('settings.audio.themes.toasts.cacheClearFailed.message'),
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
        i18n.global.t('settings.audio.themes.toasts.exported.title'),
        i18n.global.t('settings.audio.themes.toasts.exported.message'),
        2000
      )
    } catch (error) {
      debug.error('Failed to export settings:', error)
      notificationStore.showToast(
        'ui_error',
        i18n.global.t('settings.audio.themes.toasts.exportFailed.title'),
        i18n.global.t('settings.audio.themes.toasts.exportFailed.message'),
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
              i18n.global.t('settings.audio.themes.toasts.imported.title'),
              i18n.global.t('settings.audio.themes.toasts.imported.message'),
              2000
            )
          } catch (error) {
            debug.error('Failed to import settings:', error)
            notificationStore.showToast(
              'ui_error',
              i18n.global.t('settings.audio.themes.toasts.importFailed.title'),
              i18n.global.t('settings.audio.themes.toasts.importFailed.message'),
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
      localVolume.value = Math.round(themeStore.audioVolume * 100)
      notificationStore.showToast(
        'ui_success',
        i18n.global.t('settings.audio.themes.toasts.reset.title'),
        i18n.global.t('settings.audio.themes.toasts.reset.message'),
        2000
      )
    } catch (error) {
      debug.error('Failed to reset settings:', error)
      notificationStore.showToast(
        'ui_error',
        i18n.global.t('settings.audio.themes.toasts.resetFailed.title'),
        i18n.global.t('settings.audio.themes.toasts.resetFailed.message'),
        3000
      )
    }
  }

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
