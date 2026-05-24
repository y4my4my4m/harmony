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
import { useProfileStore } from '@/stores/useProfile'
import { debug } from '@/utils/debug'
import { userStorage } from '@/utils/userScopedStorage'

export interface VisualThemeSettings {
  theme: 'dark' | 'light' | 'midnight' | 'custom'
  customThemeMode?: 'dark' | 'light'
  customPrimaryColor?: string
  customAccentColor?: string
  customBackgroundColor?: string
  customBackgroundLightness?: number // -50 to +50
  customBackgroundChroma?: number // -30 to +30
  customCssOverrides?: Record<string, string>
  fontSize: number
  zoomLevel: number
  showTimestamps: boolean
  use24HourTime: boolean
  compactMode: boolean
  highContrast: boolean
  reduceMotion: boolean
  screenReaderSupport: boolean
  /** Show custom emojis in other users' display names. Instance must allow it too. */
  showCustomEmojisInDisplayNames?: boolean
  /**
   * Render `>foo` lines (no space after `>`) as imageboard-style greentext in
   * chat/DM messages. `> foo` is always a blockquote regardless of this flag.
   * Default: true (opt-out).
   */
  greentextEnabled?: boolean
}

export interface ThemePreset {
  name: string
  description: string
  settings: Partial<VisualThemeSettings>
}

export interface SavedCustomTheme {
  id: string
  name: string
  settings: Partial<VisualThemeSettings>
  createdAt: string
}

const SAVED_THEMES_KEY = 'custom-themes'

export const COMMUNITY_PRESETS: ThemePreset[] = [
  {
    name: 'Harmony Teal',
    description: 'The signature Harmony look - fresh, modern, and inviting',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#0EA5E9',
      customAccentColor: '#0EA5E9',
      customBackgroundColor: '#0EA5E9',
      customBackgroundLightness: 20,
      customBackgroundChroma: 2,
      customCssOverrides: {
        '--harmony-primary': '#0EA5E9',
        '--harmony-primary-hover': '#0284C7',
        '--harmony-accent': '#38BDF8',
      }
    }
  },
  {
    name: 'Emerald',
    description: 'Growth, balance, and natural harmony',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#10B981',
      customAccentColor: '#10B981',
      customBackgroundColor: '#10B981',
      customBackgroundLightness: 20,
      customBackgroundChroma: 2,
      customCssOverrides: {
        '--harmony-primary': '#10B981',
        '--harmony-primary-hover': '#059669',
        '--harmony-accent': '#34D399',
      }
    }
  },
  {
    name: 'Coral',
    description: 'Warm, energetic, and community-driven',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#F97316',
      customAccentColor: '#F97316',
      customBackgroundColor: '#F97316',
      customBackgroundLightness: 20,
      customBackgroundChroma: 1,
      customCssOverrides: {
        '--harmony-primary': '#F97316',
        '--harmony-primary-hover': '#EA580C',
        '--harmony-accent': '#FB923C',
      }
    }
  },
  {
    name: 'Violet',
    description: 'Creative and distinctive with deep purple tones',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#8B5CF6',
      customAccentColor: '#8B5CF6',
      customBackgroundColor: '#8B5CF6',
      customBackgroundLightness: 20,
      customBackgroundChroma: 2,
      customCssOverrides: {
        '--harmony-primary': '#8B5CF6',
        '--harmony-primary-hover': '#7C3AED',
        '--harmony-accent': '#A78BFA',
      }
    }
  },
  {
    name: 'Rose',
    description: 'Bold, warm, and community-focused',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#F43F5E',
      customAccentColor: '#F43F5E',
      customBackgroundColor: '#F43F5E',
      customBackgroundLightness: 20,
      customBackgroundChroma: 2,
      customCssOverrides: {
        '--harmony-primary': '#F43F5E',
        '--harmony-primary-hover': '#E11D48',
        '--harmony-accent': '#FB7185',
      }
    }
  },
  {
    name: 'Ocean Blue',
    description: 'A deep ocean blue theme with cool tones',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#1258fa',
      customAccentColor: '#1258fa',
      customBackgroundColor: '#1258fa',
      customBackgroundLightness: 25,
      customBackgroundChroma: 3,
      customCssOverrides: {
        '--harmony-primary': '#1258fa',
        '--harmony-primary-hover': '#0e47d4',
        '--harmony-accent': '#4ecdc4',
      }
    }
  },
  {
    name: 'Sakura',
    description: 'Cherry blossom inspired pink theme',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#e91e8c',
      customAccentColor: '#e91e8c',
      customBackgroundColor: '#e91e8c',
      customBackgroundLightness: 20,
      customBackgroundChroma: 2,
    }
  },
  {
    name: 'Forest',
    description: 'Natural green forest tones',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#2d9b4e',
      customAccentColor: '#2d9b4e',
      customBackgroundColor: '#2d9b4e',
      customBackgroundLightness: 20,
      customBackgroundChroma: 2,
    }
  },
  {
    name: 'Amber',
    description: 'Warm amber and gold tones',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#f59e0b',
      customAccentColor: '#f59e0b',
      customBackgroundColor: '#f59e0b',
      customBackgroundLightness: 20,
      customBackgroundChroma: 1,
    }
  }
]

// Preset theme color mappings
const PRESET_THEMES = {
  dark: {
    primary: '#0EA5E9',
    bgChat: '#313338',
    bgSidebar: '#292b2f',
    textPrimary: '#f2f3f5',
    textSecondary: '#b5bac1',
    borderPrimary: 'rgba(255, 255, 255, 0.08)',
    isLightTheme: false,
    secondary: '#38BDF8',
    accent: '#ff7675',
  },
  light: {
    primary: '#0EA5E9',
    bgChat: '#ffffff',
    bgSidebar: '#f2f3f5',
    textPrimary: '#2e3338',
    textSecondary: '#4e5058',
    borderPrimary: 'rgba(0, 0, 0, 0.12)',
    isLightTheme: true,
    secondary: '#38BDF8',
    accent: '#ff7675',
  },
  midnight: {
    primary: '#0EA5E9',
    bgChat: '#1e2124',
    bgSidebar: '#1a1d20',
    textPrimary: '#f2f3f5',
    textSecondary: '#b5bac1',
    borderPrimary: 'rgba(255, 255, 255, 0.08)',
    isLightTheme: false,
    secondary: '#38BDF8',
    accent: '#ff7675',
  },
}

// Global state (singleton pattern)
const settings = ref<VisualThemeSettings>({
  theme: 'dark',
  customThemeMode: 'dark',
  customPrimaryColor: '#0EA5E9',
  customAccentColor: '#0EA5E9',
  customBackgroundColor: '#0EA5E9',
  customBackgroundLightness: 0,
  customBackgroundChroma: 0,
  fontSize: 14,
  zoomLevel: 100,
  showTimestamps: true,
  use24HourTime: false,
  compactMode: false,
  highContrast: false,
  reduceMotion: false,
  screenReaderSupport: false,
  showCustomEmojisInDisplayNames: true,
  greentextEnabled: true,
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
  root.style.setProperty('--harmony-primary-hover', '#0284C7')
  root.style.setProperty('--harmony-primary-light', 'rgba(14, 165, 233, 0.1)')
  root.style.setProperty('--harmony-primary-alpha', 'rgba(14, 165, 233, 0.15)')
  root.style.setProperty('--harmony-primary-alpha-light', 'rgba(14, 165, 233, 0.1)')
  root.style.setProperty('--harmony-primary-alpha-strong', 'rgba(14, 165, 233, 0.25)')
  root.style.setProperty('--harmony-secondary', theme.secondary)
  root.style.setProperty('--harmony-secondary-hover', '#0284C7')
  root.style.setProperty('--harmony-secondary-light', 'rgba(14, 165, 233, 0.1)')
  root.style.setProperty('--harmony-secondary-alpha', 'rgba(14, 165, 233, 0.15)')
  root.style.setProperty('--harmony-secondary-alpha-light', 'rgba(14, 165, 233, 0.1)')
  root.style.setProperty('--harmony-secondary-alpha-strong', 'rgba(14, 165, 233, 0.25)')
  root.style.setProperty('--harmony-accent', theme.accent)
  root.style.setProperty('--harmony-accent-hover', '#0284C7')
  root.style.setProperty('--harmony-accent-light', 'rgba(14, 165, 233, 0.1)')
  root.style.setProperty('--harmony-accent-alpha', 'rgba(14, 165, 233, 0.15)')
  root.style.setProperty('--harmony-accent-alpha-light', 'rgba(14, 165, 233, 0.1)')
  root.style.setProperty('--harmony-accent-alpha-strong', 'rgba(14, 165, 233, 0.25)')
  root.style.setProperty('--h-primary', theme.primary)
  root.style.setProperty('--h-primary-light', '#38BDF8')
  root.style.setProperty('--h-primary-dark', '#0369A1')
  root.style.setProperty('--h-brand', theme.primary)
  
  // Background colors - use proper defaults based on theme
  if (themeName === 'dark') {
    root.style.setProperty('--h-chat', '#313338')
    root.style.setProperty('--h-chat-light', '#383a40')
    root.style.setProperty('--h-chat-lighter', '#40444b')
    root.style.setProperty('--h-chat-dark', '#141618')
    root.style.setProperty('--h-chat-darker', '#0c0d0e')
    root.style.setProperty('--h-chat-alpha', 'rgba(49, 51, 56, 0.67)')
    root.style.setProperty('--h-chat-alpha-light', 'rgba(49, 51, 56, 0.5)')
    
    root.style.setProperty('--h-sidebar', '#2b2d31')
    root.style.setProperty('--h-sidebar-light', '#35373c')
    root.style.setProperty('--h-sidebar-alpha', 'rgba(43, 45, 49, 0.67)')
    
    root.style.setProperty('--h-black', '#1e1f22')
    root.style.setProperty('--h-black-light', '#313336')
    root.style.setProperty('--h-black-lighter', '#40444b')
    root.style.setProperty('--h-black-darker', '#000000')
    root.style.setProperty('--h-black-alpha', 'rgba(30, 31, 34, 0.67)')
    
    // Original background system colors
    root.style.setProperty('--background-primary', '#1a1a1e')
    root.style.setProperty('--background-secondary', '#17181a')
    root.style.setProperty('--background-tertiary', '#121214')
    root.style.setProperty('--background-quaternary', '#222327')
    root.style.setProperty('--background-quinary', '#202024')
    // Alpha variants
    root.style.setProperty('--background-primary-alpha', '#1a1a1eaa')
    root.style.setProperty('--background-secondary-alpha', '#17181aaa')
    root.style.setProperty('--background-tertiary-alpha', '#121214aa')
    root.style.setProperty('--background-senary', '#0a0b0d')
    root.style.setProperty('--background-senary-alpha', '#0a0b0dc7')
  } else if (themeName === 'light') {
    root.style.setProperty('--h-chat', '#ffffff')
    root.style.setProperty('--h-chat-light', '#f6f6f7')
    root.style.setProperty('--h-chat-lighter', '#f2f3f5')
    root.style.setProperty('--h-chat-dark', '#e3e5e8')
    root.style.setProperty('--h-chat-darker', '#d0d2d5')
    root.style.setProperty('--h-chat-alpha', 'rgba(255, 255, 255, 0.85)')
    root.style.setProperty('--h-chat-alpha-light', 'rgba(255, 255, 255, 0.7)')
    
    root.style.setProperty('--h-sidebar', '#f2f3f5')
    root.style.setProperty('--h-sidebar-light', '#e3e5e8')
    root.style.setProperty('--h-sidebar-alpha', 'rgba(242, 243, 245, 0.85)')
    
    root.style.setProperty('--h-black', '#e3e5e8')
    root.style.setProperty('--h-black-light', '#ebedef')
    root.style.setProperty('--h-black-lighter', '#f2f3f5')
    root.style.setProperty('--h-black-darker', '#d0d2d5')
    root.style.setProperty('--h-black-alpha', 'rgba(227, 229, 232, 0.85)')
    
    root.style.setProperty('--background-primary', '#ffffff')
    root.style.setProperty('--background-secondary', '#f6f6f7')
    root.style.setProperty('--background-tertiary', '#f2f3f5')
    root.style.setProperty('--background-quaternary', '#ebedef')
    root.style.setProperty('--background-quinary', '#e3e5e8')
    // Alpha variants (lighter for light theme)
    root.style.setProperty('--background-primary-alpha', 'rgba(255, 255, 255, 0.85)')
    root.style.setProperty('--background-secondary-alpha', 'rgba(246, 246, 247, 0.85)')
    root.style.setProperty('--background-tertiary-alpha', 'rgba(242, 243, 245, 0.85)')
    root.style.setProperty('--background-senary', '#2b2d31')
    root.style.setProperty('--background-senary-alpha', 'rgba(43, 45, 49, 0.78)')
  } else if (themeName === 'midnight') {
    root.style.setProperty('--h-chat', '#1e2124')
    root.style.setProperty('--h-chat-light', '#25272a')
    root.style.setProperty('--h-chat-lighter', '#2b2d31')
    root.style.setProperty('--h-chat-dark', '#18191c')
    root.style.setProperty('--h-chat-darker', '#0f1012')
    root.style.setProperty('--h-chat-alpha', 'rgba(30, 33, 36, 0.67)')
    root.style.setProperty('--h-chat-alpha-light', 'rgba(30, 33, 36, 0.5)')
    
    root.style.setProperty('--h-sidebar', '#1a1d20')
    root.style.setProperty('--h-sidebar-light', '#1f2226')
    root.style.setProperty('--h-sidebar-alpha', 'rgba(26, 29, 32, 0.67)')
    
    root.style.setProperty('--h-black', '#13151a')
    root.style.setProperty('--h-black-light', '#1a1d20')
    root.style.setProperty('--h-black-lighter', '#1f2226')
    root.style.setProperty('--h-black-darker', '#0a0b0d')
    root.style.setProperty('--h-black-alpha', 'rgba(19, 21, 26, 0.67)')
    
    root.style.setProperty('--background-primary', '#1e2124')
    root.style.setProperty('--background-secondary', '#13151a')
    root.style.setProperty('--background-tertiary', '#0f1012')
    root.style.setProperty('--background-quaternary', '#1a1d20')
    root.style.setProperty('--background-quinary', '#13151a')
    // Alpha variants
    root.style.setProperty('--background-primary-alpha', '#1e2124aa')
    root.style.setProperty('--background-secondary-alpha', '#13151aaa')
    root.style.setProperty('--background-tertiary-alpha', '#0f1012aa')
    root.style.setProperty('--background-senary', '#0a0b0d')
    root.style.setProperty('--background-senary-alpha', '#0a0b0dc7')
  }
  
  // Text colors
  root.style.setProperty('--text-primary', theme.textPrimary)
  root.style.setProperty('--text-secondary', theme.textSecondary)
  root.style.setProperty('--text-tertiary', theme.isLightTheme ? '#6e7178' : '#80848e')
  root.style.setProperty('--text-muted', theme.isLightTheme ? '#5e6168' : '#6d6f78')
  
  // Border colors - different alpha values for light vs dark themes
  root.style.setProperty('--border-primary', theme.borderPrimary)
  root.style.setProperty('--border-secondary', theme.isLightTheme ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.06)')
  root.style.setProperty('--border-hover', theme.isLightTheme ? 'rgba(0, 0, 0, 0.15)' : 'rgba(255, 255, 255, 0.12)')
  root.style.setProperty('--border-focus', theme.primary)
  root.style.setProperty('--border-color', theme.isLightTheme ? 'rgba(0, 0, 0, 0.12)' : '#232529')
  
  // Icon colors for light/dark
  root.style.setProperty('--icon-primary', theme.isLightTheme ? '#5e6168' : '#9999a0')
  root.style.setProperty('--icon-secondary', theme.isLightTheme ? '#80838a' : '#66666b')
  root.style.setProperty('--icon-active', theme.isLightTheme ? '#2e3338' : '#fbfbfb')

  // Shadow adjustments for light theme
  root.style.setProperty('--shadow-small', theme.isLightTheme
    ? '0 2px 4px rgba(0, 0, 0, 0.06)' : '0 2px 4px rgba(0, 0, 0, 0.1)')
  root.style.setProperty('--shadow-medium', theme.isLightTheme
    ? '0 4px 8px rgba(0, 0, 0, 0.08)' : '0 4px 8px rgba(0, 0, 0, 0.15)')

  root.setAttribute('data-theme', themeName)
  root.setAttribute('data-theme-type', theme.isLightTheme ? 'light' : 'dark')
  
  debug.log(`🎨 Applied ${themeName} theme`)
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
        settings.customBackgroundColor,
        settings.customBackgroundLightness || 0,
        settings.customPrimaryColor,
        settings.customBackgroundChroma || 0
      )
      applyThemePalette(palette)
    } catch (error) {
      debug.error('Failed to apply custom theme:', error)
      applyPresetTheme('dark')
    }
  } else if (settings.theme !== 'custom') {
    applyPresetTheme(settings.theme)
  }
  
  // Apply CSS variable overrides (runs after theme so overrides take precedence)
  if (settings.customCssOverrides) {
    for (const [varName, value] of Object.entries(settings.customCssOverrides)) {
      if (varName.startsWith('--') && value) {
        root.style.setProperty(varName, value)
      }
    }
  }
  
  // Apply font size
  root.style.setProperty('--message-font-size', `${settings.fontSize}px`)
  
  // Apply zoom level. `zoom` is a non-standard CSS property not present on
  // `CSSStyleDeclaration` in lib.dom, but every browser we target understands it.
  ;(root.style as any).zoom = `${settings.zoomLevel}%`
  
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
    userStorage.setItem('visual-theme', JSON.stringify(settings))
  } catch (error) {
    debug.error('Failed to save theme to localStorage:', error)
  }
}

/**
 * Load settings from localStorage
 */
function loadFromLocalStorage(): Partial<VisualThemeSettings> | null {
  try {
    const saved = userStorage.getItem('visual-theme')
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (error) {
    debug.error('Failed to load theme from localStorage:', error)
  }
  return null
}

/**
 * Get saved custom themes from localStorage
 */
function getSavedCustomThemes(): SavedCustomTheme[] {
  try {
    const saved = userStorage.getItem(SAVED_THEMES_KEY)
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (error) {
    debug.error('Failed to load saved themes from localStorage:', error)
  }
  return []
}

/**
 * Persist saved custom themes to localStorage
 */
function saveCustomThemesToStorage(themes: SavedCustomTheme[]) {
  try {
    userStorage.setItem(SAVED_THEMES_KEY, JSON.stringify(themes))
  } catch (error) {
    debug.error('Failed to save custom themes to localStorage:', error)
  }
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
      .eq('auth_user_id', userId)
    
    if (error) throw error
    
    debug.log('✅ Visual theme settings saved to Supabase')
  } catch (error) {
    debug.error('Failed to save theme to Supabase:', error)
  } finally {
    isSaving.value = false
  }
}

/**
 * Load settings from Supabase
 * OPTIMIZED: First checks profile store to avoid redundant queries
 */
async function loadFromSupabase(): Promise<Partial<VisualThemeSettings> | null> {
  const authStore = useAuthStore()
  const profileStore = useProfileStore()
  const userId = authStore.session?.user?.id
  
  if (!userId) return null
  
  try {
    // OPTIMIZATION: Check if profile is already loaded in the store
    if (profileStore.profile?.appearance_settings) {
      debug.log('✅ Using cached appearance_settings from profile store')
      return profileStore.profile.appearance_settings as Partial<VisualThemeSettings>
    }
    
    // Fallback to direct query only if profile store doesn't have the data
    const { data, error } = await supabase
      .from('profiles')
      .select('appearance_settings')
      .eq('auth_user_id', userId)
      .maybeSingle()
    
    if (error && error.code !== 'PGRST116') throw error
    
    return data?.appearance_settings || null
  } catch (error) {
    debug.error('Failed to load theme from Supabase:', error)
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
    
    debug.log('🎨 Initializing visual theme system...')
    
    // Try to load from localStorage first (instant)
    const localSettings = loadFromLocalStorage()
    let appliedFromLocal = false
    if (localSettings) {
      Object.assign(settings.value, localSettings)
      applySettings(settings.value)
      appliedFromLocal = true
    }
    
    // Then load from Supabase and override if different
    const supabaseSettings = await loadFromSupabase()
    if (supabaseSettings) {
      // Only re-apply if settings are actually different from localStorage
      const needsUpdate = !appliedFromLocal || 
        supabaseSettings.theme !== localSettings?.theme ||
        supabaseSettings.customAccentColor !== localSettings?.customAccentColor
      
      Object.assign(settings.value, supabaseSettings)
      
      if (needsUpdate) {
        applySettings(settings.value)
      }
      saveToLocalStorage(settings.value)
    } else if (!appliedFromLocal) {
      // No localStorage or Supabase settings - apply defaults
      applySettings(settings.value)
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
    debug.log('✅ Visual theme system initialized')
  }
  
  /**
   * Update theme
   */
  function setTheme(theme: 'dark' | 'light' | 'midnight' | 'custom', customColor?: string, customBgColor?: string) {
    const previousTheme = settings.value.theme
    settings.value.theme = theme
    if (theme === 'custom') {
      if (customColor) {
        settings.value.customAccentColor = customColor
      }
      if (customBgColor) {
        settings.value.customBackgroundColor = customBgColor
      }
    } else if (previousTheme !== theme) {
      clearCssOverrides()
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
   * Set a single CSS variable override
   */
  function setCssOverride(varName: string, value: string) {
    if (!settings.value.customCssOverrides) {
      settings.value.customCssOverrides = {}
    }
    settings.value.customCssOverrides[varName] = value
    document.documentElement.style.setProperty(varName, value)
  }
  
  /**
   * Remove a CSS variable override
   */
  function removeCssOverride(varName: string) {
    if (settings.value.customCssOverrides) {
      delete settings.value.customCssOverrides[varName]
    }
    document.documentElement.style.removeProperty(varName)
  }
  
  /**
   * Clear all CSS variable overrides
   */
  function clearCssOverrides() {
    if (settings.value.customCssOverrides) {
      for (const varName of Object.keys(settings.value.customCssOverrides)) {
        document.documentElement.style.removeProperty(varName)
      }
    }
    settings.value.customCssOverrides = {}
  }
  
  /**
   * Apply a community preset
   */
  function applyPreset(preset: ThemePreset) {
    Object.assign(settings.value, preset.settings)
  }
  
  /**
   * Get all available CSS variable names for theming
   */
  function getThemableVariables(): { category: string; vars: string[] }[] {
    return [
      {
        category: 'Brand',
        vars: ['--harmony-primary', '--harmony-primary-hover', '--harmony-primary-light', '--harmony-secondary', '--harmony-accent', '--h-brand']
      },
      {
        category: 'Chat Surfaces',
        vars: ['--h-chat', '--h-chat-light', '--h-chat-lighter', '--h-chat-dark', '--h-chat-darker']
      },
      {
        category: 'Sidebar Surfaces',
        vars: ['--h-sidebar', '--h-sidebar-light', '--h-channel-sidebar']
      },
      {
        category: 'Dark Surfaces',
        vars: ['--h-black', '--h-black-light', '--h-black-lighter', '--h-black-darker']
      },
      {
        category: 'Primary (Layout)',
        vars: ['--h-primary', '--h-primary-light', '--h-primary-dark']
      },
      {
        category: 'Background',
        vars: ['--background-primary', '--background-secondary', '--background-tertiary', '--background-quaternary', '--background-quinary', '--background-senary']
      },
      {
        category: 'Text',
        vars: ['--text-primary', '--text-secondary', '--text-tertiary', '--text-muted']
      },
      {
        category: 'Icons',
        vars: ['--icon-active', '--icon-primary', '--icon-secondary', '--icon-tertiary', '--icon-muted']
      },
      {
        category: 'Status',
        vars: ['--status-online', '--status-away', '--status-busy', '--status-offline']
      },
      {
        category: 'Semantic',
        vars: ['--success', '--warning', '--error', '--info']
      },
      {
        category: 'Borders',
        vars: ['--border-primary', '--border-secondary', '--border-hover', '--border-focus']
      },
      {
        category: 'Alpha / Transparency',
        vars: ['--h-chat-alpha', '--h-chat-alpha-light', '--h-sidebar-alpha', '--h-black-alpha', '--background-primary-alpha', '--background-secondary-alpha', '--background-tertiary-alpha', '--background-senary-alpha']
      },
      {
        category: 'Tooltips & Overlays',
        vars: ['--tooltip-bg', '--tooltip-text', '--tooltip-arrow']
      }
    ]
  }
  
  /**
   * Reset theme system completely (call on logout)
   * This ensures the next user gets a fresh theme initialization
   */
  function reset() {
    isInitialized.value = false
    settings.value = {
      theme: 'dark',
      customThemeMode: 'dark',
      customPrimaryColor: '#0EA5E9',
      customAccentColor: '#0EA5E9',
      customBackgroundColor: '#0EA5E9',
      customBackgroundLightness: 0,
      customBackgroundChroma: 0,
      customCssOverrides: {},
      fontSize: 14,
      zoomLevel: 100,
      showTimestamps: true,
      use24HourTime: false,
      compactMode: false,
      highContrast: false,
      reduceMotion: false,
      screenReaderSupport: false,
      showCustomEmojisInDisplayNames: true,
    }
    // Apply default dark theme
    applyPresetTheme('dark')
    debug.log('🎨 Visual theme reset for new user')
  }

  /**
   * Reset to defaults
   */
  function resetToDefaults() {
    settings.value = {
      theme: 'dark',
      customThemeMode: 'dark',
      customPrimaryColor: '#0EA5E9',
      customAccentColor: '#0EA5E9',
      customBackgroundColor: '#0EA5E9',
      customBackgroundLightness: 0,
      customBackgroundChroma: 0,
      customCssOverrides: {},
      fontSize: 14,
      zoomLevel: 100,
      showTimestamps: true,
      use24HourTime: false,
      compactMode: false,
      highContrast: false,
      reduceMotion: false,
      screenReaderSupport: false,
      showCustomEmojisInDisplayNames: true,
    }
  }
  
  /**
   * Update custom primary color
   */
  function setCustomPrimaryColor(color: string) {
    settings.value.theme = 'custom'
    settings.value.customPrimaryColor = color
  }
  
  /**
   * Update custom background lightness
   */
  function setCustomBackgroundLightness(lightness: number) {
    settings.value.customBackgroundLightness = Math.max(-50, Math.min(50, lightness))
  }
  
  /**
   * Update custom background chroma (saturation)
   */
  function setCustomBackgroundChroma(chroma: number) {
    settings.value.customBackgroundChroma = Math.max(-30, Math.min(30, chroma))
  }
  
  /**
   * Get current settings
   */
  const currentSettings = computed(() => ({ ...settings.value }))
  
  /**
   * Export current theme as JSON string (for custom themes)
   */
  function exportThemeAsJson(): string {
    const themeOnly: Partial<VisualThemeSettings> = {
      theme: settings.value.theme,
      customThemeMode: settings.value.customThemeMode,
      customPrimaryColor: settings.value.customPrimaryColor,
      customAccentColor: settings.value.customAccentColor,
      customBackgroundColor: settings.value.customBackgroundColor,
      customBackgroundLightness: settings.value.customBackgroundLightness,
      customBackgroundChroma: settings.value.customBackgroundChroma,
      customCssOverrides: settings.value.customCssOverrides ? { ...settings.value.customCssOverrides } : undefined,
    }
    return JSON.stringify(themeOnly, null, 2)
  }
  
  /**
   * Import and apply theme from JSON string
   */
  function importThemeFromJson(json: string): boolean {
    try {
      const parsed = JSON.parse(json) as Partial<VisualThemeSettings>
      if (!parsed || typeof parsed !== 'object') return false
      // Ensure we're in custom mode and merge theme-relevant fields
      const toApply: Partial<VisualThemeSettings> = {
        theme: 'custom',
        customThemeMode: parsed.customThemeMode ?? 'dark',
        customPrimaryColor: parsed.customPrimaryColor ?? settings.value.customPrimaryColor,
        customAccentColor: parsed.customAccentColor ?? settings.value.customAccentColor,
        customBackgroundColor: parsed.customBackgroundColor ?? settings.value.customBackgroundColor,
        customBackgroundLightness: parsed.customBackgroundLightness ?? settings.value.customBackgroundLightness,
        customBackgroundChroma: parsed.customBackgroundChroma ?? settings.value.customBackgroundChroma,
        customCssOverrides: parsed.customCssOverrides ? { ...parsed.customCssOverrides } : undefined,
      }
      Object.assign(settings.value, toApply)
      return true
    } catch {
      return false
    }
  }
  
  /**
   * Save current theme to "My themes" in localStorage
   */
  function saveCurrentThemeAsCustom(name: string): SavedCustomTheme | null {
    if (!name?.trim()) return null
    const theme: SavedCustomTheme = {
      id: crypto.randomUUID(),
      name: name.trim(),
      settings: {
        theme: 'custom',
        customThemeMode: settings.value.customThemeMode,
        customPrimaryColor: settings.value.customPrimaryColor,
        customAccentColor: settings.value.customAccentColor,
        customBackgroundColor: settings.value.customBackgroundColor,
        customBackgroundLightness: settings.value.customBackgroundLightness,
        customBackgroundChroma: settings.value.customBackgroundChroma,
        customCssOverrides: settings.value.customCssOverrides ? { ...settings.value.customCssOverrides } : undefined,
      },
      createdAt: new Date().toISOString(),
    }
    const list = getSavedCustomThemes()
    list.unshift(theme)
    saveCustomThemesToStorage(list)
    return theme
  }
  
  /**
   * Load and apply a saved custom theme
   */
  function loadSavedTheme(id: string): boolean {
    const list = getSavedCustomThemes()
    const found = list.find(t => t.id === id)
    if (!found?.settings) return false
    Object.assign(settings.value, found.settings)
    settings.value.theme = 'custom'
    return true
  }
  
  /**
   * Delete a saved custom theme
   */
  function deleteSavedTheme(id: string): void {
    const list = getSavedCustomThemes().filter(t => t.id !== id)
    saveCustomThemesToStorage(list)
  }
  
  /**
   * Apply instance default theme if the user has no custom theme set.
   * Called on app init for new / unauthenticated users.
   */
  function loadInstanceDefaultTheme(themeJson: string | null): boolean {
    if (!themeJson) return false
    if (settings.value.theme !== 'dark') return false
    return importThemeFromJson(themeJson)
  }

  return {
    // State
    settings: computed(() => settings.value),
    isInitialized: computed(() => isInitialized.value),
    isSaving: computed(() => isSaving.value),
    
    // Methods
    initialize,
    loadInstanceDefaultTheme,
    setTheme,
    setCustomThemeMode,
    setCustomPrimaryColor,
    setCustomAccentColor,
    setCustomBackgroundColor,
    setCustomBackgroundLightness,
    setCustomBackgroundChroma,
    setFontSize,
    setZoomLevel,
    toggleShowTimestamps,
    toggle24HourTime,
    toggleCompactMode,
    toggleHighContrast,
    toggleReduceMotion,
    toggleScreenReaderSupport,
    updateSettings,
    resetToDefaults,
    reset,
    currentSettings,
    setCssOverride,
    removeCssOverride,
    clearCssOverrides,
    applyPreset,
    getThemableVariables,
    exportThemeAsJson,
    importThemeFromJson,
    getSavedCustomThemes,
    saveCurrentThemeAsCustom,
    loadSavedTheme,
    deleteSavedTheme,
  }
}

