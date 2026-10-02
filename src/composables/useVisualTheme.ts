/**
 * Visual Theme Composable
 * 
 * Manages visual theme settings including:
 * - Preset themes (dark, light, midnight)
 * - Custom OKLCH-based themes
 * - Real-time theme application
 * - Persistence to localStorage and Supabase
 */

import { ref, computed, watch, nextTick, effectScope, toRaw } from 'vue'
import {
  generateThemePalette,
  applyThemePalette,
  applySurfaceSemanticTokens,
  canonicalizeBackgroundTone,
} from '@/utils/colorUtils'
import { supabase } from '@/supabase'
import { useAuthStore } from '@/stores/auth'
import { useProfileStore } from '@/stores/useProfile'
import { debug } from '@/utils/debug'
import { userStorage } from '@/utils/userScopedStorage'
import { audioThemeService } from '@/services/AudioThemeService'
import { BUILTIN_SKINS } from './skins'
import type { VisualThemeSettings } from './useVisualTheme.types'

const AUDIO_THEME_WHEN_SKIN_CLEARED = 'default'

/** Look up a skin's `linkedAudioTheme` (declared on the skin manifest). */
function getLinkedAudioTheme(skinId: string): string | undefined {
  return BUILTIN_SKINS.find((s) => s.id === skinId)?.linkedAudioTheme
}

export type { VisualThemeSettings } from './useVisualTheme.types'
export { BUILTIN_SKINS, type Skin } from './skins'

/**
 * CSS font stacks for each `fontFamily` option. Update both this map and
 * `applySettings` if you add a new option.
 */
export const FONT_STACKS: Record<NonNullable<VisualThemeSettings['fontFamily']>, string> = {
  system: `'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`,
  pixel: `'NoRe Sans Pixel Pro', 'Figtree', monospace`,
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
      customAccentColor: '#f472b6',
      customBackgroundColor: '#e91e8c',
      customBackgroundLightness: 20,
      customBackgroundChroma: 2,
      customCssOverrides: {
        '--harmony-primary': '#e91e8c',
        '--harmony-primary-hover': '#be185d',
        '--harmony-accent': '#f9a8d4',
      }
    }
  },
  {
    name: 'Forest',
    description: 'Natural green forest tones',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#2d9b4e',
      customAccentColor: '#34d399',
      customBackgroundColor: '#2d9b4e',
      customBackgroundLightness: 20,
      customBackgroundChroma: 2,
      customCssOverrides: {
        '--harmony-primary': '#2d9b4e',
        '--harmony-primary-hover': '#22863a',
        '--harmony-accent': '#6ee7b7',
      }
    }
  },
  {
    name: 'Amber',
    description: 'Warm amber and gold tones',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#f59e0b',
      customAccentColor: '#fbbf24',
      customBackgroundColor: '#f59e0b',
      customBackgroundLightness: 20,
      customBackgroundChroma: 1,
      customCssOverrides: {
        '--harmony-primary': '#f59e0b',
        '--harmony-primary-hover': '#d97706',
        '--harmony-accent': '#fcd34d',
      }
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

/** Preset matching the OS colour scheme; dark where matchMedia is absent. */
function systemPreset(): 'light' | 'dark' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function createDefaultSettings(theme: VisualThemeSettings['theme'] = 'dark'): VisualThemeSettings {
  return {
    theme,
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
    greentextEnabled: true,
    inviteBannerBackground: true,
    bridgeSourceBadge: 'icon',
    fontFamily: 'system',
    glassEffectsEnabled: true,
    activeSkinId: null,
    customSkinCss: '',
  }
}

// Global state (singleton pattern)
const settings = ref<VisualThemeSettings>(createDefaultSettings(systemPreset()))

const isInitialized = ref(false)
const isSaving = ref(false)

// Auth user whose settings are applied; null while signed out, undefined
// before the first initialize().
let appliedFor: string | null | undefined
let pendingLoad: { userId: string | null; promise: Promise<void> } | null = null
// Signed out, the theme tracks prefers-color-scheme and nothing persists.
let followSystem = false
// Set while stored settings are written into `settings`; the persist watcher
// skips those writes.
let loadingStored = false
let persistWatcherStarted = false
let systemSchemeListenerAttached = false

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
    // Background system colors
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
    root.style.setProperty('--background-primary', '#1e2124')
    root.style.setProperty('--background-secondary', '#13151a')
    root.style.setProperty('--background-tertiary', '#0f1012')
    // Raised surface (composer, inputs): CIE L* 17.4 over the 12.6 chat
    // surface, +4.8. The dark preset sits at +4.3.
    root.style.setProperty('--background-quaternary', '#282b30')
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
  // Written inline by applyThemePalette only; the design-system alias applies to presets.
  root.style.removeProperty('--color-border')

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

  applySurfaceSemanticTokens(theme.isLightTheme, themeName)
  
  debug.log(`Applied ${themeName} theme`)
}

// Override variables the last applySettings wrote inline on :root.
let appliedOverrideVars = new Set<string>()

/**
 * Apply all visual settings to DOM
 */
function applySettings(settings: VisualThemeSettings) {
  const root = document.documentElement

  // Overrides dropped since the last apply leave the inline value behind; the
  // theme pass below rewrites the variables it owns.
  const overrides = settings.customCssOverrides ?? {}
  for (const varName of appliedOverrideVars) {
    if (!overrides[varName]) root.style.removeProperty(varName)
  }
  
  if (settings.theme === 'custom' && settings.customAccentColor) {
    try {
      const palette = generateThemePalette(
        settings.customAccentColor,
        settings.customThemeMode,
        settings.customBackgroundColor,
        settings.customBackgroundLightness || 0,
        settings.customPrimaryColor,
        settings.customBackgroundChroma || 0,
        settings.customSidebarColor
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
  appliedOverrideVars = new Set()
  for (const [varName, value] of Object.entries(overrides)) {
    if (varName.startsWith('--') && value) {
      root.style.setProperty(varName, value)
      appliedOverrideVars.add(varName)
    }
  }
  
  root.style.setProperty('--message-font-size', `${settings.fontSize}px`)

  // Apply UI font family (the picker in Appearance settings flips this).
  // `--font-family` is consumed by `body` in design-system.css and by the
  // `html, body` rule in App.vue; setting it on `:root` cascades to both.
  const fontKey = settings.fontFamily || 'system'
  const fontStack = FONT_STACKS[fontKey] || FONT_STACKS.system
  root.style.setProperty('--font-family', fontStack)

  // Apply glass effects preference. The setting itself uses positive
  // framing (`glassEffectsEnabled`), but the CSS hook stays
  // `data-disable-blur` because that's what the global rule in
  // `design-system.css` keys off - internal implementation detail.
  if (!settings.glassEffectsEnabled) {
    root.setAttribute('data-disable-blur', 'true')
  } else {
    root.removeAttribute('data-disable-blur')
  }

  // Apply active skin id (data attribute used by skin-scoped CSS rules)
  // and inject the skin's global CSS into a dedicated <style> tag so we
  // can swap skins cleanly without leaking rules.
  if (settings.activeSkinId) {
    root.setAttribute('data-skin', settings.activeSkinId)
  } else {
    root.removeAttribute('data-skin')
  }

  // Apply per-skin decorative option attributes (`data-skin-<optionId>=on|off`).
  // For the active skin, every option declared in its manifest gets an
  // attribute reflecting the user's stored value (falling back to the
  // option's declared default). When no skin is active OR the skin has
  // no options, all known option attrs are stripped so they never leak
  // across skin switches.
  const ALL_OPTION_IDS = new Set<string>()
  for (const skin of BUILTIN_SKINS) {
    for (const option of skin.options || []) ALL_OPTION_IDS.add(option.id)
  }
  for (const optionId of ALL_OPTION_IDS) {
    root.removeAttribute(`data-skin-${optionId}`)
  }
  if (settings.activeSkinId) {
    const skin = BUILTIN_SKINS.find((s) => s.id === settings.activeSkinId)
    const stored = settings.skinOptions?.[settings.activeSkinId] || {}
    for (const option of skin?.options || []) {
      const value = stored[option.id] ?? option.default
      root.setAttribute(`data-skin-${option.id}`, value ? 'on' : 'off')
    }
  }

  if (typeof document !== 'undefined') {
    // A built-in skin resolves from the registry; the persisted copy is the
    // stylesheet of whichever build applied it.
    const skinCss =
      BUILTIN_SKINS.find((s) => s.id === settings.activeSkinId)?.globalCss ||
      settings.customSkinCss
    let skinStyleEl = document.getElementById('harmony-skin-styles') as HTMLStyleElement | null
    if (skinCss) {
      if (!skinStyleEl) {
        skinStyleEl = document.createElement('style')
        skinStyleEl.id = 'harmony-skin-styles'
        document.head.appendChild(skinStyleEl)
      }
      if (skinStyleEl.textContent !== skinCss) {
        skinStyleEl.textContent = skinCss
      }
    } else if (skinStyleEl) {
      skinStyleEl.remove()
    }
  }
  
  // Apply zoom level. `zoom` is a non-standard CSS property not present on
  // `CSSStyleDeclaration` in lib.dom, but every browser we target understands it.
  ;(root.style as any).zoom = `${settings.zoomLevel}%`
  
  if (settings.compactMode) {
    root.setAttribute('data-compact-mode', 'true')
  } else {
    root.removeAttribute('data-compact-mode')
  }
  
  if (settings.highContrast) {
    root.setAttribute('data-high-contrast', 'true')
  } else {
    root.removeAttribute('data-high-contrast')
  }
  
  if (settings.reduceMotion) {
    root.setAttribute('data-reduce-motion', 'true')
  } else {
    root.removeAttribute('data-reduce-motion')
  }
  
  if (settings.showTimestamps) {
    root.setAttribute('data-show-timestamps', 'true')
  } else {
    root.removeAttribute('data-show-timestamps')
  }
  
  if (settings.screenReaderSupport) {
    root.setAttribute('data-screen-reader', 'true')
  } else {
    root.removeAttribute('data-screen-reader')
  }
}

/**
 * Backwards-compat: convert legacy `disableGlassBlur` (negative framing)
 * to the new `glassEffectsEnabled` (positive framing). Existing profiles'
 * `appearance_settings` JSONB and old localStorage payloads will have
 * the legacy field; this rewrites it in-place so the rest of the system
 * only ever sees the new shape.
 */
function migrateLegacyBlurSetting(loaded: Partial<VisualThemeSettings> & { disableGlassBlur?: boolean }) {
  if ('disableGlassBlur' in loaded && loaded.glassEffectsEnabled === undefined) {
    loaded.glassEffectsEnabled = !loaded.disableGlassBlur
    delete loaded.disableGlassBlur
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
    
    debug.log('Visual theme settings saved to Supabase')
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
    if (profileStore.profile?.appearance_settings) {
      debug.log('Using cached appearance_settings from profile store')
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

/** Deep copy through JSON; settings are JSON by construction (persisted as JSONB). */
export function cloneSettings(s: VisualThemeSettings): VisualThemeSettings {
  return JSON.parse(JSON.stringify(toRaw(s)))
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, v[k]]))
      : v,
  )
}

/** Equality ignoring key order and undefined-valued keys. */
export function settingsEqual(a: VisualThemeSettings, b: VisualThemeSettings): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

/** Values of every key a skin can change; taken before the first skin applies. */
function snapshotSkinTargets(s: VisualThemeSettings): Partial<VisualThemeSettings> {
  return {
    theme: s.theme,
    customThemeMode: s.customThemeMode,
    customPrimaryColor: s.customPrimaryColor,
    customAccentColor: s.customAccentColor,
    customBackgroundColor: s.customBackgroundColor,
    customSidebarColor: s.customSidebarColor,
    customBackgroundLightness: s.customBackgroundLightness,
    customBackgroundChroma: s.customBackgroundChroma,
    customCssOverrides: s.customCssOverrides ? { ...s.customCssOverrides } : {},
    fontFamily: s.fontFamily,
  }
}

/**
 * Settings after applying a skin, or clearing it with null or an unknown id.
 * No side effects; the linked audio theme is the caller's.
 *
 * Applying merges the skin's `themeOverrides`, sets `activeSkinId` and keeps
 * the skin's CSS in `customSkinCss` so it round-trips through
 * `appearance_settings` without the registry. The first skin applied takes a
 * `_preSkinSnapshot`, so apply A, apply B, clear restores the state from
 * before A. Clearing restores that snapshot, or the defaults of the
 * skin-affected keys when none exists. `glassEffectsEnabled` is never
 * touched; a skin needing blur off does so in its scoped CSS.
 */
export function resolveSkin(base: VisualThemeSettings, skinId: string | null): VisualThemeSettings {
  const next = cloneSettings(base)
  const skin = skinId ? BUILTIN_SKINS.find((s) => s.id === skinId) : undefined
  if (!skin) {
    if (next._preSkinSnapshot) {
      Object.assign(next, next._preSkinSnapshot)
    } else if (next.activeSkinId) {
      next.theme = 'dark'
      next.customCssOverrides = {}
      next.fontFamily = 'system'
    }
    next._preSkinSnapshot = undefined
    next.activeSkinId = null
    next.customSkinCss = ''
    return next
  }
  if (!next.activeSkinId && !next._preSkinSnapshot) {
    next._preSkinSnapshot = snapshotSkinTargets(next)
  }
  Object.assign(next, JSON.parse(JSON.stringify(skin.themeOverrides)))
  next.activeSkinId = skin.id
  next.customSkinCss = skin.globalCss || ''
  return next
}

/** Settings after applying a community preset; overrides come only from the preset. */
export function withPreset(base: VisualThemeSettings, preset: ThemePreset): VisualThemeSettings {
  const next = cloneSettings(base)
  Object.assign(next, JSON.parse(JSON.stringify(preset.settings)))
  next.customCssOverrides = { ...(preset.settings.customCssOverrides ?? {}) }
  if (next.customBackgroundColor) {
    next.customBackgroundColor = canonicalizeBackgroundTone(
      next.customBackgroundColor,
      next.customBackgroundLightness ?? 0,
      next.customBackgroundChroma ?? 0,
      (next.customThemeMode || 'dark') as 'light' | 'dark',
    )
  }
  return next
}

/**
 * Main composable
 */
export function useVisualTheme() {
  /**
   * Load and apply the settings for the current session. Signed out, the
   * preset follows prefers-color-scheme; signed in, stored settings win and a
   * user with none starts from the system preset. Re-runs when the session
   * user changes, so an in-app sign-in applies the stored theme.
   */
  async function initialize() {
    const userId = useAuthStore().session?.user?.id ?? null
    if (isInitialized.value && appliedFor === userId) return
    if (pendingLoad?.userId === userId) return pendingLoad.promise
    const promise = loadFor(userId).finally(() => {
      if (pendingLoad?.promise === promise) pendingLoad = null
    })
    pendingLoad = { userId, promise }
    return promise
  }

  async function loadFor(userId: string | null) {
    debug.log('Initializing visual theme system...')
    attachSystemSchemeListener()
    loadingStored = true
    try {
      if (!userId) {
        followSystem = true
        settings.value = createDefaultSettings(systemPreset())
        applySettings(settings.value)
      } else {
        followSystem = false
        const next = createDefaultSettings(systemPreset())

        // localStorage first (sync, no flash), then the profile copy.
        const localSettings = loadFromLocalStorage()
        if (localSettings) {
          migrateLegacyBlurSetting(localSettings)
          Object.assign(next, localSettings)
          settings.value = { ...next }
          applySettings(settings.value)
        }

        const supabaseSettings = await loadFromSupabase()
        if (supabaseSettings) {
          migrateLegacyBlurSetting(supabaseSettings)
          Object.assign(next, supabaseSettings)
        }
        settings.value = next
        applySettings(settings.value)
        if (supabaseSettings) saveToLocalStorage(settings.value)
      }

      appliedFor = userId
      isInitialized.value = true
      startPersistWatcher()
      syncLinkedAudioOnInit(settings.value.activeSkinId)
      // Pre-flush watcher runs queued by the writes above see loadingStored.
      await nextTick()
      debug.log('Visual theme system initialized')
    } finally {
      loadingStored = false
    }
  }

  /** Applies every change; persists only for a signed-in user. */
  function startPersistWatcher() {
    if (persistWatcherStarted) return
    persistWatcherStarted = true
    // Detached scope: a component scope active at the first initialize() call
    // would stop the watcher on unmount.
    effectScope(true).run(() => {
      watch(
        settings,
        (newSettings) => {
          applySettings(newSettings)
          if (loadingStored || !appliedFor) return
          saveToLocalStorage(newSettings)
          debouncedSaveToSupabase(newSettings)
        },
        { deep: true }
      )
    })
  }

  function attachSystemSchemeListener() {
    if (systemSchemeListenerAttached) return
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    systemSchemeListenerAttached = true
    const query = window.matchMedia('(prefers-color-scheme: light)')
    query.addEventListener?.('change', () => {
      if (followSystem) settings.value.theme = systemPreset()
    })
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
   * Update UI font family. Persists via the same `appearance_settings`
   * sync flow as the rest of the theme.
   */
  function setFontFamily(family: NonNullable<VisualThemeSettings['fontFamily']>) {
    if (!FONT_STACKS[family]) return
    settings.value.fontFamily = family
  }

  /**
   * Toggle the glass effects (blur / translucency) preference.
   */
  function setGlassEffectsEnabled(enabled: boolean) {
    settings.value.glassEffectsEnabled = !!enabled
  }

  /**
   * Switch to the audio theme linked to a visual skin (if any). Snapshots the
   * user's current audio theme once so `clearSkin` can restore it.
   */
  function applySkinLinkedAudioTheme(skinId: string): void {
    const linkedThemeId = getLinkedAudioTheme(skinId)
    if (!linkedThemeId) return
    if (!settings.value._preSkinAudioTheme) {
      settings.value._preSkinAudioTheme =
        audioThemeService.getSettings().selectedTheme
    }
    void audioThemeService.setTheme(linkedThemeId)
  }

  /**
   * Restore the pre-skin audio theme after clearing a linked skin.
   */
  function restorePreSkinAudioTheme(): void {
    const previous = settings.value._preSkinAudioTheme
    settings.value._preSkinAudioTheme = undefined
    void audioThemeService.setTheme(previous ?? AUDIO_THEME_WHEN_SKIN_CLEARED)
  }

  /**
   * On reload, re-apply linked audio if a skin is active but audio drifted.
   */
  function syncLinkedAudioOnInit(activeSkinId: string | null | undefined): void {
    if (!activeSkinId) return
    const linkedThemeId = getLinkedAudioTheme(activeSkinId)
    if (!linkedThemeId) return
    if (audioThemeService.getSettings().selectedTheme === linkedThemeId) return
    if (!settings.value._preSkinAudioTheme) {
      settings.value._preSkinAudioTheme =
        audioThemeService.getSettings().selectedTheme
    }
    void audioThemeService.setTheme(linkedThemeId)
  }

  /**
   * Set a per-skin decorative option (e.g. scanline on/off). Stored as
   * `skinOptions[skinId][optionId]` and reflected to the DOM as
   * `<html data-skin-<optionId>="on|off">` by `applySettings` below.
   */
  function setSkinOption(skinId: string, optionId: string, value: boolean): void {
    if (!settings.value.skinOptions) settings.value.skinOptions = {}
    if (!settings.value.skinOptions[skinId]) settings.value.skinOptions[skinId] = {}
    settings.value.skinOptions[skinId][optionId] = value
  }

  /**
   * Read a skin option's effective value: stored override if present,
   * otherwise the option's declared `default`. Returns `undefined` for
   * unknown skin/option ids.
   */
  function getSkinOption(skinId: string, optionId: string): boolean | undefined {
    const skin = BUILTIN_SKINS.find((s) => s.id === skinId)
    const option = skin?.options?.find((o) => o.id === optionId)
    if (!option) return undefined
    const stored = settings.value.skinOptions?.[skinId]?.[optionId]
    return stored ?? option.default
  }

  /** Switches the linked audio theme when the active skin changes. */
  function syncSkinAudio(prevSkinId: string | null, nextSkinId: string | null): void {
    if (prevSkinId === nextSkinId) return
    if (nextSkinId) applySkinLinkedAudioTheme(nextSkinId)
    else restorePreSkinAudioTheme()
  }

  /**
   * Apply a skin by id, or clear it with null. See resolveSkin for the
   * settings change; the linked audio theme follows.
   */
  function applySkin(skinId: string | null) {
    if (skinId && !BUILTIN_SKINS.some((s) => s.id === skinId)) {
      debug.warn(`applySkin: unknown skin id "${skinId}", clearing`)
    }
    const prev = settings.value.activeSkinId ?? null
    settings.value = resolveSkin(settings.value, skinId)
    syncSkinAudio(prev, settings.value.activeSkinId ?? null)
  }

  function clearSkin() {
    applySkin(null)
  }

  /**
   * Writes `draft` to the DOM without storing it. The next applySettings call
   * (reapplySettings, or any stored change) replaces the preview.
   */
  function previewSettings(draft: VisualThemeSettings) {
    applySettings(draft)
  }

  /** Stores and applies `next` as a whole, with the skin's audio side effect. */
  function commitSettings(next: VisualThemeSettings) {
    const prev = settings.value.activeSkinId ?? null
    settings.value = cloneSettings(next)
    syncSkinAudio(prev, settings.value.activeSkinId ?? null)
    applySettings(settings.value)
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
   * Write the stored settings to the DOM. The settings watcher fires only on a
   * value change, so a live preview reverted to identical settings stays on
   * screen without this.
   */
  function reapplySettings() {
    applySettings(settings.value)
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
    settings.value = withPreset(settings.value, preset)
  }
  
  /**
   * Get all available CSS variable names for theming
   */
  function getThemableVariables(): { category: string; vars: string[] }[] {
    return [
      {
        category: 'Navigation Rail',
        vars: [
          '--nav-rail-button-bg',
          '--nav-rail-button-icon',
          '--channel-item-hover-bg',
          '--channel-item-selected-bg',
        ]
      },
      {
        category: 'Brand',
        vars: ['--harmony-primary', '--harmony-primary-hover', '--harmony-primary-light', '--harmony-secondary', '--harmony-accent', '--h-brand']
      },
      {
        category: 'Primary (Layout)',
        vars: ['--h-primary', '--h-primary-light', '--h-primary-dark']
      },
      {
        category: 'Background Surfaces',
        vars: ['--background-primary', '--background-secondary', '--background-tertiary', '--background-quaternary', '--background-quinary', '--background-senary', '--background-septenary', '--h-channel-sidebar']
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
        vars: ['--background-primary-alpha', '--background-secondary-alpha', '--background-tertiary-alpha', '--background-senary-alpha']
      },
      {
        category: 'Tooltips & Overlays',
        vars: ['--tooltip-bg', '--tooltip-text', '--tooltip-arrow']
      }
    ]
  }
  
  /**
   * Signed-out state (call on logout): defaults, system preset, no
   * persistence. The next sign-in loads that user's settings.
   */
  function reset() {
    followSystem = true
    appliedFor = null
    pendingLoad = null
    isInitialized.value = true
    settings.value = createDefaultSettings(systemPreset())
    applySettings(settings.value)
    debug.log('Visual theme reset for new user')
  }

  /**
   * Reset to defaults
   */
  function resetToDefaults() {
    settings.value = createDefaultSettings(systemPreset())
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
  
  /** Theme-only JSON of `source` (the stored settings by default). */
  function exportThemeAsJson(source: VisualThemeSettings = settings.value): string {
    const themeOnly: Partial<VisualThemeSettings> = {
      theme: source.theme,
      customThemeMode: source.customThemeMode,
      customPrimaryColor: source.customPrimaryColor,
      customAccentColor: source.customAccentColor,
      customBackgroundColor: source.customBackgroundColor,
      customSidebarColor: source.customSidebarColor,
      customBackgroundLightness: source.customBackgroundLightness,
      customBackgroundChroma: source.customBackgroundChroma,
      customCssOverrides: source.customCssOverrides ? { ...source.customCssOverrides } : undefined,
    }
    return JSON.stringify(themeOnly, null, 2)
  }

  /**
   * Theme fields from an exported JSON string, merged over `base` and forced
   * to the custom theme; null when the text is not a theme object.
   */
  function parseThemeJson(json: string, base: VisualThemeSettings = settings.value): Partial<VisualThemeSettings> | null {
    try {
      const parsed = JSON.parse(json) as Partial<VisualThemeSettings>
      if (!parsed || typeof parsed !== 'object') return null
      return {
        theme: 'custom',
        customThemeMode: parsed.customThemeMode ?? 'dark',
        customPrimaryColor: parsed.customPrimaryColor ?? base.customPrimaryColor,
        customAccentColor: parsed.customAccentColor ?? base.customAccentColor,
        customBackgroundColor: parsed.customBackgroundColor ?? base.customBackgroundColor,
        customSidebarColor: parsed.customSidebarColor ?? base.customSidebarColor,
        customBackgroundLightness: parsed.customBackgroundLightness ?? base.customBackgroundLightness,
        customBackgroundChroma: parsed.customBackgroundChroma ?? base.customBackgroundChroma,
        customCssOverrides: parsed.customCssOverrides ? { ...parsed.customCssOverrides } : undefined,
      }
    } catch {
      return null
    }
  }
  
  /**
   * Import and apply theme from JSON string
   */
  function importThemeFromJson(json: string): boolean {
    const theme = parseThemeJson(json)
    if (!theme) return false
    Object.assign(settings.value, theme)
    return true
  }
  
  /** Saves the colours of `source` (the stored settings by default) to "My themes". */
  function saveCurrentThemeAsCustom(
    name: string,
    source: VisualThemeSettings = settings.value,
  ): SavedCustomTheme | null {
    if (!name?.trim()) return null
    const theme: SavedCustomTheme = {
      id: crypto.randomUUID(),
      name: name.trim(),
      settings: {
        theme: 'custom',
        customThemeMode: source.customThemeMode,
        customPrimaryColor: source.customPrimaryColor,
        customAccentColor: source.customAccentColor,
        customBackgroundColor: source.customBackgroundColor,
        customSidebarColor: source.customSidebarColor,
        customBackgroundLightness: source.customBackgroundLightness,
        customBackgroundChroma: source.customBackgroundChroma,
        customCssOverrides: source.customCssOverrides ? { ...source.customCssOverrides } : undefined,
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
    setFontFamily,
    setGlassEffectsEnabled,
    applySkin,
    clearSkin,
    previewSettings,
    commitSettings,
    setSkinOption,
    getSkinOption,
    toggleShowTimestamps,
    toggle24HourTime,
    toggleCompactMode,
    toggleHighContrast,
    toggleReduceMotion,
    toggleScreenReaderSupport,
    updateSettings,
    reapplySettings,
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
    parseThemeJson,
    getSavedCustomThemes,
    saveCurrentThemeAsCustom,
    loadSavedTheme,
    deleteSavedTheme,
  }
}

