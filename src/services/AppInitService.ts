/**
 * App Initialization Service
 * 
 * Handles initialization of all app-wide settings and features on startup
 */

import { useVisualTheme } from '@/composables/useVisualTheme'
import { setLocale } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { supabase } from '@/supabase'

/**
 * Initialize all app settings
 */
export async function initializeAppSettings() {
  console.log('🚀 Initializing app settings...')
  
  try {
    // Initialize visual theme system
    const visualTheme = useVisualTheme()
    await visualTheme.initialize()
    
    // Load user-specific settings if logged in
    const authStore = useAuthStore()
    if (authStore.session?.user?.id) {
      await loadUserSettings(authStore.session.user.id)
    }
    
    console.log('✅ App settings initialized successfully')
  } catch (error) {
    console.error('❌ Failed to initialize app settings:', error)
  }
}

/**
 * Load user-specific settings from Supabase
 */
async function loadUserSettings(userId: string) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('appearance_settings, locale')
      .eq('id', userId)
      .single()
    
    if (error) throw error
    
    // Apply locale if available
    if (data?.locale) {
      setLocale(data.locale)
    }
    
    // Appearance settings are already loaded by useVisualTheme.initialize()
    // but we can verify they were loaded
    if (data?.appearance_settings) {
      console.log('📋 User appearance settings loaded from database')
    }
    
    return data
  } catch (error) {
    console.error('Failed to load user settings:', error)
    return null
  }
}

/**
 * Apply default settings for new users or fallback
 */
export function applyDefaultSettings() {
  const visualTheme = useVisualTheme()
  visualTheme.resetToDefaults()
  setLocale('en')
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
      setLocale(settings.locale)
    }
    
    console.log('✅ Settings imported successfully')
    return true
  } catch (error) {
    console.error('❌ Failed to import settings:', error)
    return false
  }
}

