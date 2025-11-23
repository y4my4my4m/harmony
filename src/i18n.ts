/**
 * i18n Configuration
 * Internationalization setup for Harmony
 */

import { createI18n } from 'vue-i18n'
import en from './locales/en.json'
import es from './locales/es.json'
import fr from './locales/fr.json'
import de from './locales/de.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

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
    console.error('Failed to save locale:', error)
  }
}

// Get initial locale
function getInitialLocale(): string {
  const savedLocale = getSavedLocale()
  if (savedLocale) {
    return savedLocale
  }

  const browserLocale = getBrowserLocale()
  const supportedLocales = ['en', 'es', 'fr', 'de', 'ja', 'ko', 'zh']

  if (supportedLocales.includes(browserLocale)) {
    return browserLocale
  }

  return 'en' // Default to English
}

// Create i18n instance
export const i18n = createI18n({
  legacy: false, // Use Composition API mode
  locale: getInitialLocale(),
  fallbackLocale: 'en',
  messages: {
    en,
    es,
    fr,
    de,
    ja,
    ko,
    zh,
  },
  globalInjection: true,
})

// Export locale helper
export function setLocale(locale: string): void {
  i18n.global.locale.value = locale
  saveLocale(locale)
  
  // Update HTML lang attribute
  document.documentElement.setAttribute('lang', locale)
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

