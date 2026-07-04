/**
 * Haptic Settings Composable
 * 
 * Manages haptic feedback preferences and provides methods to trigger
 * haptics only when enabled by user settings.
 */

import { ref, watch } from 'vue'
import { hapticManager, type HapticPattern } from '@/utils/hapticFeedback'
import { debug } from '@/utils/debug'
import { userStorage } from '@/utils/userScopedStorage'

// Shared state across all composable instances
const isEnabled = ref(true)
const isInitialized = ref(false)

// Specific haptic triggers that can be individually controlled
const hapticTriggers = ref({
  messages: false,     // Send message (off by default - can be annoying)
  reactions: true,     // Add/remove reactions
  navigation: true,    // Tab changes, drawer open/close
  voice: true,         // Join/leave voice, mute/unmute
  interactions: true,  // Long press, pull to refresh
  toggles: true,       // Toggle switches, checkboxes
  destructive: true,   // Delete, leave server, etc.
})

/**
 * Load haptic settings from localStorage
 */
function loadSettings(): void {
  if (isInitialized.value) return
  
  try {
    const enabled = userStorage.getItem('haptics-enabled')
    isEnabled.value = enabled !== null ? enabled === 'true' : true
    
    const triggers = userStorage.getItem('haptic-triggers')
    if (triggers) {
      const parsed = JSON.parse(triggers)
      hapticTriggers.value = { ...hapticTriggers.value, ...parsed }
    }
    
    // Sync with hapticManager
    hapticManager.setEnabled(isEnabled.value)
    
    isInitialized.value = true
    debug.log('🎮 Haptic settings loaded:', { enabled: isEnabled.value, triggers: hapticTriggers.value })
  } catch (error) {
    debug.error('Failed to load haptic settings:', error)
  }
}

/**
 * Save haptic settings to localStorage
 */
function saveSettings(): void {
  try {
    userStorage.setItem('haptics-enabled', isEnabled.value.toString())
    userStorage.setItem('haptic-triggers', JSON.stringify(hapticTriggers.value))
    hapticManager.setEnabled(isEnabled.value)
  } catch (error) {
    debug.error('Failed to save haptic settings:', error)
  }
}

/**
 * Trigger haptic feedback if enabled for the given category
 */
function triggerHaptic(
  category: keyof typeof hapticTriggers.value,
  pattern: HapticPattern = 'light'
): void {
  if (!isEnabled.value) return
  if (!hapticTriggers.value[category]) return
  
  hapticManager.trigger({ pattern })
}

/**
 * Composable for haptic settings
 */
export function useHapticSettings() {
  // Load settings on first use
  loadSettings()
  
  // Watch for changes and save
  watch(isEnabled, saveSettings)
  watch(hapticTriggers, saveSettings, { deep: true })
  
  return {
    // State
    isEnabled,
    hapticTriggers,
    isSupported: hapticManager.supported,
    
    // Methods
    triggerHaptic,
    
    // Quick trigger methods with category check
    triggerMessage: (pattern: HapticPattern = 'light') => triggerHaptic('messages', pattern),
    triggerReaction: () => triggerHaptic('reactions', 'selection'),
    triggerNavigation: (pattern: HapticPattern = 'light') => triggerHaptic('navigation', pattern),
    triggerVoice: (pattern: HapticPattern = 'medium') => triggerHaptic('voice', pattern),
    triggerInteraction: (pattern: HapticPattern = 'medium') => triggerHaptic('interactions', pattern),
    triggerToggle: () => triggerHaptic('toggles', 'selection'),
    triggerDestructive: (pattern: HapticPattern = 'warning') => triggerHaptic('destructive', pattern),
    
    // Direct haptic manager access for custom patterns
    hapticManager
  }
}

