/**
 * Push-to-Talk Composable
 * 
 * This is a backward-compatible wrapper around the unified useKeybinds system.
 * New code should use useKeybinds directly.
 * 
 * @deprecated Use useKeybinds for new implementations
 */

import { computed, ref } from 'vue'
import { useKeybinds, type KeybindModifiers } from './useKeybinds'

// =============================================================================
// TYPES (Re-exported for backward compatibility)
// =============================================================================

export type InputMode = 'voice_activity' | 'push_to_talk'

export interface PTTSettings {
  inputMode: InputMode
  pttKey: string
  pttKeyDisplay: string
  pttModifiers: PTTModifiers
  releaseDelay: number
}

export interface PTTModifiers {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

// =============================================================================
// COMPOSABLE
// =============================================================================

/**
 * Push-to-Talk composable - wraps the unified keybind system
 * @deprecated Use useKeybinds directly for new code
 */
export function usePushToTalk() {
  const keybinds = useKeybinds()
  
  // Local state for keybind recording (not part of useKeybinds)
  const isRecordingKeybind = ref(false)
  
  // Get the PTT keybind
  const pttKeybind = computed(() => keybinds.getKeybind('push-to-talk'))
  
  // Computed values that map to the old API
  const inputMode = keybinds.inputMode
  const pttKey = computed(() => pttKeybind.value?.key ?? 'KeyV')
  const pttKeyDisplay = computed(() => keybinds.getKeybindDisplay('push-to-talk'))
  const pttModifiers = computed<PTTModifiers>(() => pttKeybind.value?.modifiers ?? { ctrl: false, alt: false, shift: false, meta: false })
  const releaseDelay = keybinds.releaseDelay
  const isPTTActive = keybinds.isPTTActive
  const isPTTMode = keybinds.isPTTMode
  const isVoiceActivityMode = keybinds.isVoiceActivityMode
  
  // Should be muted when in PTT mode and key is not held
  const shouldBeMuted = computed(() => {
    if (keybinds.inputMode.value === 'voice_activity') {
      return false
    }
    return !keybinds.isPTTActive.value
  })
  
  // Actions
  const setInputMode = (mode: InputMode): void => {
    keybinds.setInputMode(mode)
  }
  
  const startRecordingKeybind = (): void => {
    isRecordingKeybind.value = true
  }
  
  const cancelRecordingKeybind = (): void => {
    isRecordingKeybind.value = false
  }
  
  const recordKeybind = (event: KeyboardEvent): boolean => {
    if (!isRecordingKeybind.value) return false
    
    // Ignore modifier-only keys
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
      return false
    }
    
    // Ignore Escape (used to cancel)
    if (event.code === 'Escape') {
      cancelRecordingKeybind()
      return true
    }
    
    // Record the keybind using the new system
    const modifiers: KeybindModifiers = {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    }
    
    keybinds.setKeybind('push-to-talk', event.code, modifiers)
    isRecordingKeybind.value = false
    
    return true
  }
  
  const setReleaseDelay = (delay: number): void => {
    keybinds.setReleaseDelay(delay)
  }
  
  const resetToDefaults = (): void => {
    keybinds.resetKeybind('push-to-talk')
  }
  
  /**
   * Check if a keyboard event should be blocked because it conflicts with PTT
   */
  const shouldBlockShortcut = (event: KeyboardEvent): boolean => {
    return keybinds.shouldBlockShortcut(event, [])
  }
  
  /**
   * Register a callback to be called when mute state should change
   * This is called by the voice store to respond to PTT state changes
   */
  const registerMuteCallback = (callback: (muted: boolean) => void): void => {
    keybinds.registerHandler('push-to-talk', (isPressed: boolean) => {
      callback(!isPressed) // isPressed=true means unmuted, so muted=false
    })
  }
  
  /**
   * Unregister the mute callback
   */
  const unregisterMuteCallback = (): void => {
    keybinds.unregisterHandler('push-to-talk')
  }
  
  // Lifecycle - delegate to useKeybinds
  const setupListeners = (): void => {
    keybinds.setupListeners()
  }
  
  const cleanupListeners = (): void => {
    keybinds.cleanupListeners()
  }
  
  return {
    // State (readonly)
    inputMode,
    pttKey,
    pttKeyDisplay,
    pttModifiers,
    releaseDelay,
    isPTTActive,
    isRecordingKeybind: computed(() => isRecordingKeybind.value),
    
    // Computed
    isPTTMode,
    isVoiceActivityMode,
    shouldBeMuted,
    
    // Actions
    setInputMode,
    startRecordingKeybind,
    cancelRecordingKeybind,
    recordKeybind,
    setReleaseDelay,
    resetToDefaults,
    
    // Utilities for other components
    shouldBlockShortcut,
    
    // Callback management
    registerMuteCallback,
    unregisterMuteCallback,
    
    // Lifecycle
    setupListeners,
    cleanupListeners,
  }
}
