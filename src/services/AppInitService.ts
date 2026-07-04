/**
 * App Initialization Service
 * 
 * Handles initialization of all app-wide settings and features on startup
 * OPTIMIZED: Uses profile store to avoid redundant database queries
 */

import { useVisualTheme } from '@/composables/useVisualTheme'
import { setLocale } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { useProfileStore } from '@/stores/useProfile'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { ensureEmojiDataLoaded } from '@/composables/useEmojiLoader'
import { debug } from '@/utils/debug'

/**
 * Initialize all app settings
 */
export async function initializeAppSettings() {
  debug.log('🚀 Initializing app settings...')
  
  try {
    // Initialize instance settings first (affects UI visibility)
    const instanceSettings = useInstanceSettingsStore()
    await instanceSettings.fetchSettings()
    
    const visualTheme = useVisualTheme()
    await visualTheme.initialize()
    
    const authStore = useAuthStore()
    if (authStore.session?.user?.id) {
      await loadUserSettings()

      // Preload emoji data so display names render correctly on first paint
      // Uses IndexedDB cache so subsequent loads are near-instant
      ensureEmojiDataLoaded().catch(() => {})
    }
    
    debug.log('✅ App settings initialized successfully')
  } catch (error) {
    debug.error('❌ Failed to initialize app settings:', error)
  }
}

/**
 * Load user-specific settings from profile store
 * OPTIMIZED: Uses cached profile data instead of separate queries
 */
async function loadUserSettings() {
  try {
    const profileStore = useProfileStore()
    const profile = profileStore.profile
    
    if (!profile) {
      debug.log('📋 No profile loaded yet, settings will load when profile is available')
      return null
    }
    
    if (profile.locale) {
      await setLocale(profile.locale)
    }
    
    // Appearance settings are handled by useVisualTheme.initialize()
    if (profile.appearance_settings) {
      debug.log('📋 User settings available from profile store')
    }
    
    return profile
  } catch (error) {
    debug.error('Failed to load user settings from profile store:', error)
    return null
  }
}

/**
 * Apply default settings for new users or fallback
 */
export async function applyDefaultSettings() {
  const visualTheme = useVisualTheme()
  visualTheme.resetToDefaults()
  await setLocale('en')
}

/**
 * Export user settings for backup
 */
export async function exportUserSettings() {
  const visualTheme = useVisualTheme()
  const settings = visualTheme.currentSettings.value
  
  return {
    appearance: settings,
    locale: localStorage.getItem('harmony-locale') || 'en',
    exportedAt: new Date().toISOString(),
  }
}

/**
 * Import user settings from backup
 */
export async function importUserSettings(settings: any) {
  try {
    const visualTheme = useVisualTheme()
    
    if (settings.appearance) {
      visualTheme.updateSettings(settings.appearance)
    }
    
    if (settings.locale) {
      await setLocale(settings.locale)
    }
    
    debug.log('✅ Settings imported successfully')
    return true
  } catch (error) {
    debug.error('❌ Failed to import settings:', error)
    return false
  }
}

