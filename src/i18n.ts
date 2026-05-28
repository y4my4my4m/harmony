/**
 * i18n Configuration
 * Internationalization setup for Harmony
 * 
 * OPTIMIZED: Lazy-loads locale files to reduce initial bundle size by ~220KB
 * Only the initial locale is loaded, other locales are loaded on-demand
 */

import { createI18n } from 'vue-i18n'
import { debug } from '@/utils/debug'

// Supported locales
const supportedLocales = ['en', 'es', 'fr', 'de', 'ja', 'ko', 'zh'] as const
export type SupportedLocale = typeof supportedLocales[number]

// Locale loading cache
const loadedLocales = new Map<string, any>()

/**
 * Lazy-load a locale file
 * Returns cached locale if already loaded
 */
async function loadLocale(locale: string): Promise<any> {
  // Return cached locale if already loaded
  if (loadedLocales.has(locale)) {
    return loadedLocales.get(locale)
  }

  // Only load supported locales
  if (!supportedLocales.includes(locale as SupportedLocale)) {
    debug.warn(`Unsupported locale: ${locale}, falling back to 'en'`)
    return loadLocale('en')
  }

  try {
    // Dynamically import the locale file
    const localeModule = await import(`./locales/${locale}.json`)
    const messages = localeModule.default || localeModule
    loadedLocales.set(locale, messages)
    debug.log(`📦 Loaded locale: ${locale}`)
    return messages
  } catch (error) {
    debug.error(`Failed to load locale ${locale}:`, error)
    // Fallback to English if locale fails to load
    if (locale !== 'en') {
      return loadLocale('en')
    }
    throw error
  }
}

// Detect browser language
function getBrowserLocale(): string {
  const navigatorLocale =
    navigator.languages !== undefined
      ? navigator.languages[0]
      : navigator.language

  if (!navigatorLocale) {
    return 'en'
  }

  // Extract language code (en-US -> en)
  const languageCode = navigatorLocale.trim().split(/-|_/)[0]
  return languageCode
}

// Get saved locale from localStorage
function getSavedLocale(): string | null {
  try {
    return localStorage.getItem('harmony-locale')
  } catch (error) {
    return null
  }
}

// Save locale to localStorage
export function saveLocale(locale: string): void {
  try {
    localStorage.setItem('harmony-locale', locale)
  } catch (error) {
    debug.error('Failed to save locale:', error)
  }
}

// Get initial locale
function getInitialLocale(): string {
  const savedLocale = getSavedLocale()
  if (savedLocale) {
    return savedLocale
  }

  const browserLocale = getBrowserLocale()

  if (supportedLocales.includes(browserLocale as SupportedLocale)) {
    return browserLocale
  }

  return 'en' // Default to English
}

// Get initial locale
const initialLocale = getInitialLocale()

// Create i18n instance with empty messages initially
// We'll load the initial locale asynchronously
export const i18n = createI18n({
  legacy: false, // Use Composition API mode
  locale: initialLocale,
  fallbackLocale: 'en',
  messages: {}, // Start empty, will be populated by loadInitialLocale
  globalInjection: true,
})

// Promise that resolves when initial locale is loaded
let initialLocalePromise: Promise<void> | null = null

/**
 * Load the initial locale synchronously (for critical path)
 * This is called immediately after i18n creation
 */
async function loadInitialLocale(): Promise<void> {
  try {
    const messages = await loadLocale(initialLocale)
    i18n.global.setLocaleMessage(initialLocale, messages)
    // Also set as fallback if it's not English
    if (initialLocale !== 'en') {
      const enMessages = await loadLocale('en')
      i18n.global.setLocaleMessage('en', enMessages)
    }
    debug.log(`✅ Initial locale loaded: ${initialLocale}`)
  } catch (error) {
    debug.error('Failed to load initial locale:', error)
    throw error
  }
}

// Start loading initial locale immediately
initialLocalePromise = loadInitialLocale().catch(err => {
  debug.error('Critical: Failed to load initial locale:', err)
  // Return void so promise still resolves (app can continue with empty translations)
  return Promise.resolve()
})

/**
 * Wait for initial locale to load
 * Call this before mounting the app to ensure translations are available
 */
export async function waitForInitialLocale(): Promise<void> {
  if (initialLocalePromise) {
    await initialLocalePromise
  }
}

// Export locale helper with lazy loading
export async function setLocale(locale: string): Promise<void> {
  // Load locale if not already loaded
  if (!loadedLocales.has(locale)) {
    await loadLocale(locale)
  }

  // Set the locale messages if not already set
  if (!i18n.global.availableLocales.includes(locale)) {
    const messages = loadedLocales.get(locale)
    if (messages) {
      i18n.global.setLocaleMessage(locale, messages)
    }
  }

  // Switch to the locale
  i18n.global.locale.value = locale
  saveLocale(locale)
  
  // Update HTML lang attribute
  document.documentElement.setAttribute('lang', locale)
  
  debug.log(`🌐 Switched to locale: ${locale}`)
}

export function getLocale(): string {
  return i18n.global.locale.value
}

export const availableLocales = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'zh', name: '中文' },
]

