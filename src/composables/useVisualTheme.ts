/**
 * Visual Theme Composable
 * 
 * Manages visual theme settings including:
 * - Preset themes (dark, light, midnight)
 * - Custom OKLCH-based themes
 * - Real-time theme application
 * - Persistence to localStorage and Supabase
 */

import { ref, computed, watch } from 'vue'
import { generateThemePalette, applyThemePalette, type ThemePalette } from '@/utils/colorUtils'
import { supabase } from '@/supabase'
import { useAuthStore } from '@/stores/auth'

export interface VisualThemeSettings {
  theme: 'dark' | 'light' | 'midnight' | 'custom'
  customThemeMode?: 'dark' | 'light'
  customAccentColor?: string
  customBackgroundColor?: string
  fontSize: number
  zoomLevel: number
  messageDisplay: 'cozy' | 'compact'
  showTimestamps: boolean
  use24HourTime: boolean
  compactMode: boolean
  highContrast: boolean
  reduceMotion: boolean
  screenReaderSupport: boolean
}

// Preset theme color mappings
const PRESET_THEMES = {
  dark: {
    primary: '#5865f2',
    bgChat: '#313338',
    bgSidebar: '#292b2f',
    textPrimary: '#f2f3f5',
    textSecondary: '#b5bac1',
    borderPrimary: 'rgba(255, 255, 255, 0.08)',
    isLightTheme: false,
  },
  light: {
    primary: '#5865f2',
    bgChat: '#ffffff',
    bgSidebar: '#f2f3f5',
    textPrimary: '#2e3338',
    textSecondary: '#4e5058',
    borderPrimary: 'rgba(0, 0, 0, 0.12)',
    isLightTheme: true,
  },
  midnight: {
    primary: '#5865f2',
    bgChat: '#1e2124',
    bgSidebar: '#1a1d20',
    textPrimary: '#f2f3f5',
    textSecondary: '#b5bac1',
    borderPrimary: 'rgba(255, 255, 255, 0.08)',
    isLightTheme: false,
  },
}

// Global state (singleton pattern)
const settings = ref<VisualThemeSettings>({
  theme: 'dark',
  customThemeMode: 'dark',
  customAccentColor: '#5865f2',
  customBackgroundColor: '#5865f2',
  fontSize: 14,
  zoomLevel: 100,
  messageDisplay: 'cozy',
  showTimestamps: true,
  use24HourTime: false,
  compactMode: false,
  highContrast: false,
  reduceMotion: false,
  screenReaderSupport: false,
})

const isInitialized = ref(false)
const isSaving = ref(false)

let saveTimeout: ReturnType<typeof setTimeout> | null = null

/**
 * Apply preset theme styles
 */
function applyPresetTheme(themeName: 'dark' | 'light' | 'midnight') {
  const root = document.documentElement
  const theme = PRESET_THEMES[themeName]
  
  // Primary colors
  root.style.setProperty('--harmony-primary', theme.primary)
  root.style.setProperty('--harmony-primary-hover', '#4752c4')
  root.style.setProperty('--harmony-primary-light', 'rgba(88, 101, 242, 0.1)')
  root.style.setProperty('--h-primary', theme.primary)
  root.style.setProperty('--h-primary-light', '#5983c8')
  root.style.setProperty('--h-primary-dark', '#1e3585')
  
  // Background colors - use proper defaults based on theme
  if (themeName === 'dark') {
    root.style.setProperty('--h-chat', '#313338')
    root.style.setProperty('--h-chat-light', '#383a40')
    root.style.setProperty('--h-chat-lighter', '#40444b')
    root.style.setProperty('--h-chat-dark', '#141618')
    root.style.setProperty('--h-chat-darker', '#0c0d0e')
    
    root.style.setProperty('--h-sidebar', '#2b2d31')
    root.style.setProperty('--h-sidebar-light', '#35373c')
    
    root.style.setProperty('--h-black', '#1e1f22')
    root.style.setProperty('--h-black-light', '#313336')
    root.style.setProperty('--h-black-lighter', '#40444b')
    root.style.setProperty('--h-black-darker', '#0c0d0e')
    
    // Original background system colors
    root.style.setProperty('--background-primary', '#1a1a1e')
    root.style.setProperty('--background-secondary', '#17181a')
    root.style.setProperty('--background-tertiary', '#121214')
    root.style.setProperty('--background-quaternary', '#222327')
    root.style.setProperty('--background-quinary', '#202024')
  } else if (themeName === 'light') {
    root.style.setProperty('--h-chat', '#ffffff')
    root.style.setProperty('--h-chat-light', '#f6f6f7')
    root.style.setProperty('--h-chat-lighter', '#f2f3f5')
    root.style.setProperty('--h-chat-dark', '#e3e5e8')
    root.style.setProperty('--h-chat-darker', '#d0d2d5')
    
    root.style.setProperty('--h-sidebar', '#f2f3f5')
    root.style.setProperty('--h-sidebar-light', '#e3e5e8')
    
    root.style.setProperty('--h-black', '#e3e5e8')
    root.style.setProperty('--h-black-light', '#ebedef')
    root.style.setProperty('--h-black-lighter', '#f2f3f5')
    root.style.setProperty('--h-black-darker', '#d0d2d5')
    
    root.style.setProperty('--background-primary', '#ffffff')
    root.style.setProperty('--background-secondary', '#f6f6f7')
    root.style.setProperty('--background-tertiary', '#f2f3f5')
    root.style.setProperty('--background-quaternary', '#ebedef')
    root.style.setProperty('--background-quinary', '#e3e5e8')
  } else if (themeName === 'midnight') {
    root.style.setProperty('--h-chat', '#1e2124')
    root.style.setProperty('--h-chat-light', '#25272a')
    root.style.setProperty('--h-chat-lighter', '#2b2d31')
    root.style.setProperty('--h-chat-dark', '#18191c')
    root.style.setProperty('--h-chat-darker', '#0f1012')
    
    root.style.setProperty('--h-sidebar', '#1a1d20')
    root.style.setProperty('--h-sidebar-light', '#1f2226')
    
    root.style.setProperty('--h-black', '#13151a')
    root.style.setProperty('--h-black-light', '#1a1d20')
    root.style.setProperty('--h-black-lighter', '#1f2226')
    root.style.setProperty('--h-black-darker', '#0a0b0d')
    
    root.style.setProperty('--background-primary', '#1e2124')
    root.style.setProperty('--background-secondary', '#13151a')
    root.style.setProperty('--background-tertiary', '#0f1012')
    root.style.setProperty('--background-quaternary', '#1a1d20')
    root.style.setProperty('--background-quinary', '#13151a')
  }
  
  // Text colors
  root.style.setProperty('--text-primary', theme.textPrimary)
  root.style.setProperty('--text-secondary', theme.textSecondary)
  root.style.setProperty('--text-tertiary', theme.isLightTheme ? '#6e7178' : '#80848e')
  root.style.setProperty('--text-muted', theme.isLightTheme ? '#5e6168' : '#6d6f78')
  
  // Border colors
  root.style.setProperty('--border-primary', theme.borderPrimary)
  root.style.setProperty('--border-secondary', theme.isLightTheme ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.06)')
  
  root.setAttribute('data-theme', themeName)
  root.setAttribute('data-theme-type', theme.isLightTheme ? 'light' : 'dark')
  
  console.log(`🎨 Applied ${themeName} theme`)
}

/**
 * Apply all visual settings to DOM
 */
function applySettings(settings: VisualThemeSettings) {
  const root = document.documentElement
  
  // Apply theme
  if (settings.theme === 'custom' && settings.customAccentColor) {
    try {
      const palette = generateThemePalette(
        settings.customAccentColor,
        settings.customThemeMode,
        settings.customBackgroundColor
      )
      applyThemePalette(palette)
    } catch (error) {
      console.error('Failed to apply custom theme:', error)
      applyPresetTheme('dark')
    }
  } else if (settings.theme !== 'custom') {
    applyPresetTheme(settings.theme)
  }
  
  // Apply font size
  root.style.setProperty('--message-font-size', `${settings.fontSize}px`)
  root.style.fontSize = `${settings.fontSize}px`
  
  // Apply zoom level
  root.style.zoom = `${settings.zoomLevel}%`
  
  // Apply message display mode
  root.setAttribute('data-message-display', settings.messageDisplay)
  
  // Apply compact mode
  if (settings.compactMode) {
    root.setAttribute('data-compact-mode', 'true')
  } else {
    root.removeAttribute('data-compact-mode')
  }
  
  // Apply high contrast mode
  if (settings.highContrast) {
    root.setAttribute('data-high-contrast', 'true')
  } else {
    root.removeAttribute('data-high-contrast')
  }
  
  // Apply reduce motion
  if (settings.reduceMotion) {
    root.setAttribute('data-reduce-motion', 'true')
  } else {
    root.removeAttribute('data-reduce-motion')
  }
  
  // Apply timestamps visibility
  if (settings.showTimestamps) {
    root.setAttribute('data-show-timestamps', 'true')
  } else {
    root.removeAttribute('data-show-timestamps')
  }
  
  // Apply screen reader support
  if (settings.screenReaderSupport) {
    root.setAttribute('data-screen-reader', 'true')
  } else {
    root.removeAttribute('data-screen-reader')
  }
}

/**
 * Save settings to localStorage
 */
function saveToLocalStorage(settings: VisualThemeSettings) {
  try {
    localStorage.setItem('harmony-visual-theme', JSON.stringify(settings))
  } catch (error) {
    console.error('Failed to save theme to localStorage:', error)
  }
}

/**
 * Load settings from localStorage
 */
function loadFromLocalStorage(): Partial<VisualThemeSettings> | null {
  try {
    const saved = localStorage.getItem('harmony-visual-theme')
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (error) {
    console.error('Failed to load theme from localStorage:', error)
  }
  return null
}

/**
 * Save settings to Supabase (debounced)
 */
async function saveToSupabase(settings: VisualThemeSettings) {
  const authStore = useAuthStore()
  const userId = authStore.session?.user?.id
  
  if (!userId) return
  
  try {
    isSaving.value = true
    
    const { error } = await supabase
      .from('profiles')
      .update({
        appearance_settings: settings,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
    
    if (error) throw error
    
    console.log('✅ Visual theme settings saved to Supabase')
  } catch (error) {
    console.error('Failed to save theme to Supabase:', error)
  } finally {
    isSaving.value = false
  }
}

/**
 * Load settings from Supabase
 */
async function loadFromSupabase(): Promise<Partial<VisualThemeSettings> | null> {
  const authStore = useAuthStore()
  const userId = authStore.session?.user?.id
  
  if (!userId) return null
  
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('appearance_settings')
      .eq('id', userId)
      .single()
    
    if (error) throw error
    
    return data?.appearance_settings || null
  } catch (error) {
    console.error('Failed to load theme from Supabase:', error)
    return null
  }
}

/**
 * Debounced save to Supabase
 */
function debouncedSaveToSupabase(settings: VisualThemeSettings) {
  if (saveTimeout) {
    clearTimeout(saveTimeout)
  }
  
  saveTimeout = setTimeout(() => {
    saveToSupabase(settings)
  }, 1000)
}

/**
 * Main composable
 */
export function useVisualTheme() {
  /**
   * Initialize theme system
   */
  async function initialize() {
    if (isInitialized.value) return
    
    console.log('🎨 Initializing visual theme system...')
    
    // Try to load from localStorage first (instant)
    const localSettings = loadFromLocalStorage()
    if (localSettings) {
      Object.assign(settings.value, localSettings)
      applySettings(settings.value)
    }
    
    // Then load from Supabase and override if available
    const supabaseSettings = await loadFromSupabase()
    if (supabaseSettings) {
      Object.assign(settings.value, supabaseSettings)
      applySettings(settings.value)
      saveToLocalStorage(settings.value)
    }
    
    // Watch for changes and persist
    watch(
      settings,
      (newSettings) => {
        // Apply settings immediately for real-time feedback
        applySettings(newSettings)
        // Save to localStorage immediately
        saveToLocalStorage(newSettings)
        // Debounce save to Supabase
        debouncedSaveToSupabase(newSettings)
      },
      { deep: true, immediate: false }
    )
    
    isInitialized.value = true
    console.log('✅ Visual theme system initialized')
  }
  
  /**
   * Update theme
   */
  function setTheme(theme: 'dark' | 'light' | 'midnight' | 'custom', customColor?: string, customBgColor?: string) {
    settings.value.theme = theme
    if (theme === 'custom') {
      if (customColor) {
        settings.value.customAccentColor = customColor
      }
      if (customBgColor) {
        settings.value.customBackgroundColor = customBgColor
      }
    }
  }
  
  /**
   * Update custom theme mode
   */
  function setCustomThemeMode(mode: 'dark' | 'light') {
    settings.value.customThemeMode = mode
  }
  
  /**
   * Update custom accent color
   */
  function setCustomAccentColor(color: string) {
    settings.value.theme = 'custom'
    settings.value.customAccentColor = color
  }
  
  /**
   * Update custom background color
   */
  function setCustomBackgroundColor(color: string) {
    settings.value.theme = 'custom'
    settings.value.customBackgroundColor = color
  }
  
  /**
   * Update font size
   */
  function setFontSize(size: number) {
    settings.value.fontSize = Math.max(12, Math.min(20, size))
  }
  
  /**
   * Update zoom level
   */
  function setZoomLevel(zoom: number) {
    settings.value.zoomLevel = Math.max(50, Math.min(200, zoom))
  }
  
  /**
   * Update message display mode
   */
  function setMessageDisplay(mode: 'cozy' | 'compact') {
    settings.value.messageDisplay = mode
  }
  
  /**
   * Toggle settings
   */
  function toggleShowTimestamps() {
    settings.value.showTimestamps = !settings.value.showTimestamps
  }
  
  function toggle24HourTime() {
    settings.value.use24HourTime = !settings.value.use24HourTime
  }
  
  function toggleCompactMode() {
    settings.value.compactMode = !settings.value.compactMode
  }
  
  function toggleHighContrast() {
    settings.value.highContrast = !settings.value.highContrast
  }
  
  function toggleReduceMotion() {
    settings.value.reduceMotion = !settings.value.reduceMotion
  }
  
  function toggleScreenReaderSupport() {
    settings.value.screenReaderSupport = !settings.value.screenReaderSupport
  }
  
  /**
   * Bulk update settings
   */
  function updateSettings(newSettings: Partial<VisualThemeSettings>) {
    Object.assign(settings.value, newSettings)
  }
  
  /**
   * Reset to defaults
   */
  function resetToDefaults() {
    settings.value = {
      theme: 'dark',
      customThemeMode: 'dark',
      customAccentColor: '#5865f2',
      customBackgroundColor: '#5865f2',
      fontSize: 14,
      zoomLevel: 100,
      messageDisplay: 'cozy',
      showTimestamps: true,
      use24HourTime: false,
      compactMode: false,
      highContrast: false,
      reduceMotion: false,
      screenReaderSupport: false,
    }
  }
  
  /**
   * Get current settings
   */
  const currentSettings = computed(() => ({ ...settings.value }))
  
  return {
    // State
    settings: computed(() => settings.value),
    isInitialized: computed(() => isInitialized.value),
    isSaving: computed(() => isSaving.value),
    
    // Methods
    initialize,
    setTheme,
    setCustomThemeMode,
    setCustomAccentColor,
    setCustomBackgroundColor,
    setFontSize,
    setZoomLevel,
    setMessageDisplay,
    toggleShowTimestamps,
    toggle24HourTime,
    toggleCompactMode,
    toggleHighContrast,
    toggleReduceMotion,
    toggleScreenReaderSupport,
    updateSettings,
    resetToDefaults,
    currentSettings,
  }
}

