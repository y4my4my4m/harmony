/**
 * Developer Tools Composable
 *
 * Manages the "Developer tools" / "Developer Mode" setting from advanced user settings.
 * When enabled, unlocks extra debugging actions (e.g. "Copy raw data" in message context menu).
 */

import { ref, watch } from 'vue'
import { userStorage } from '@/utils/userScopedStorage'
import { debug } from '@/utils/debug'

const STORAGE_KEY = 'developer-tools-enabled'

// Shared state across all composable instances
const isEnabled = ref(false)
const isInitialized = ref(false)

function loadFromStorage(): void {
  if (typeof window === 'undefined') return

  try {
    const stored = userStorage.getItem(STORAGE_KEY)
    isEnabled.value = stored === 'true'
    isInitialized.value = true
  } catch (error) {
    debug.error('Failed to load developer tools setting:', error)
    isEnabled.value = false
    isInitialized.value = true
  }
}

function saveToStorage(): void {
  if (typeof window === 'undefined') return

  try {
    userStorage.setItem(STORAGE_KEY, isEnabled.value.toString())
  } catch (error) {
    debug.error('Failed to save developer tools setting:', error)
  }
}

/**
 * Composable for developer tools setting
 */
export function useDeveloperTools() {
  if (!isInitialized.value) {
    loadFromStorage()
  }

  watch(isEnabled, saveToStorage)

  return {
    developerToolsEnabled: isEnabled,
    setDeveloperToolsEnabled: (enabled: boolean) => {
      isEnabled.value = enabled
    },
  }
}
