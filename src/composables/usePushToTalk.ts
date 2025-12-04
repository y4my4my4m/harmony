/**
 * Push-to-Talk Composable
 * 
 * Manages global Push-to-Talk state and keybindings.
 * Works with both P2P and SFU voice connections.
 * 
 * Usage:
 * - When PTT mode is enabled, user must hold the configured key to talk
 * - When Voice Activity mode is enabled (default), audio is always transmitted
 * - The PTT key can be customized in settings
 */

import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { debug } from '@/utils/debug'

// =============================================================================
// TYPES
// =============================================================================

export type InputMode = 'voice_activity' | 'push_to_talk'

export interface PTTSettings {
  inputMode: InputMode
  pttKey: string
  pttKeyDisplay: string
  pttModifiers: PTTModifiers
  releaseDelay: number // ms to wait before muting after key release
}

export interface PTTModifiers {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_PTT_KEY = 'KeyV'
const DEFAULT_PTT_KEY_DISPLAY = 'V'
const DEFAULT_RELEASE_DELAY = 200 // 200ms delay to avoid cutting off words
const STORAGE_KEY = 'harmony-ptt-settings'

// =============================================================================
// SHARED STATE (singleton pattern)
// =============================================================================

const inputMode = ref<InputMode>('voice_activity')
const pttKey = ref<string>(DEFAULT_PTT_KEY)
const pttKeyDisplay = ref<string>(DEFAULT_PTT_KEY_DISPLAY)
const pttModifiers = ref<PTTModifiers>({ ctrl: false, alt: false, shift: false, meta: false })
const releaseDelay = ref<number>(DEFAULT_RELEASE_DELAY)
const isPTTActive = ref<boolean>(false) // Is PTT key currently held?
const isRecordingKeybind = ref<boolean>(false) // Is user recording a new keybind?
const isInitialized = ref<boolean>(false)

// Internal state for debouncing
let releaseTimer: ReturnType<typeof setTimeout> | null = null
let onMuteCallback: ((muted: boolean) => void) | null = null

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Convert a KeyboardEvent to a display-friendly string
 */
function keyEventToDisplay(event: KeyboardEvent): string {
  const parts: string[] = []
  
  if (event.ctrlKey && event.code !== 'ControlLeft' && event.code !== 'ControlRight') {
    parts.push('Ctrl')
  }
  if (event.altKey && event.code !== 'AltLeft' && event.code !== 'AltRight') {
    parts.push('Alt')
  }
  if (event.shiftKey && event.code !== 'ShiftLeft' && event.code !== 'ShiftRight') {
    parts.push('Shift')
  }
  if (event.metaKey && event.code !== 'MetaLeft' && event.code !== 'MetaRight') {
    parts.push('Meta')
  }
  
  // Get the key name
  let keyName = event.code
  
  // Make common keys more readable
  const keyMappings: Record<string, string> = {
    'Space': 'Space',
    'Backquote': '`',
    'Minus': '-',
    'Equal': '=',
    'BracketLeft': '[',
    'BracketRight': ']',
    'Backslash': '\\',
    'Semicolon': ';',
    'Quote': "'",
    'Comma': ',',
    'Period': '.',
    'Slash': '/',
  }
  
  if (keyMappings[keyName]) {
    keyName = keyMappings[keyName]
  } else if (keyName.startsWith('Key')) {
    keyName = keyName.slice(3) // Remove "Key" prefix
  } else if (keyName.startsWith('Digit')) {
    keyName = keyName.slice(5) // Remove "Digit" prefix
  } else if (keyName.startsWith('Numpad')) {
    keyName = 'Num' + keyName.slice(6) // Replace "Numpad" with "Num"
  } else if (keyName.includes('Left') || keyName.includes('Right')) {
    // For modifier keys like ControlLeft, just use the base name
    keyName = keyName.replace('Left', '').replace('Right', '')
  }
  
  parts.push(keyName)
  
  return parts.join(' + ')
}

/**
 * Load PTT settings from localStorage
 */
function loadSettings(): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const settings: PTTSettings = JSON.parse(stored)
      inputMode.value = settings.inputMode || 'voice_activity'
      pttKey.value = settings.pttKey || DEFAULT_PTT_KEY
      pttKeyDisplay.value = settings.pttKeyDisplay || DEFAULT_PTT_KEY_DISPLAY
      pttModifiers.value = settings.pttModifiers || { ctrl: false, alt: false, shift: false, meta: false }
      releaseDelay.value = settings.releaseDelay ?? DEFAULT_RELEASE_DELAY
      debug.log('🎤 [PTT] Loaded settings:', settings)
    }
    isInitialized.value = true
  } catch (error) {
    debug.warn('⚠️ [PTT] Failed to load settings:', error)
    isInitialized.value = true
  }
}

/**
 * Save PTT settings to localStorage
 */
function saveSettings(): void {
  try {
    const settings: PTTSettings = {
      inputMode: inputMode.value,
      pttKey: pttKey.value,
      pttKeyDisplay: pttKeyDisplay.value,
      pttModifiers: pttModifiers.value,
      releaseDelay: releaseDelay.value,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    debug.log('💾 [PTT] Saved settings:', settings)
  } catch (error) {
    debug.warn('⚠️ [PTT] Failed to save settings:', error)
  }
}

// =============================================================================
// KEY EVENT HANDLERS
// =============================================================================

/**
 * Check if a keyboard event matches the PTT keybind (including modifiers)
 */
function matchesPTTKey(event: KeyboardEvent): boolean {
  if (event.code !== pttKey.value) return false
  
  const mods = pttModifiers.value
  return (
    event.ctrlKey === mods.ctrl &&
    event.altKey === mods.alt &&
    event.shiftKey === mods.shift &&
    event.metaKey === mods.meta
  )
}

/**
 * Check if the base key (without modifiers) is part of the PTT keybind
 * Used by other components to know if they should skip their shortcuts
 */
function isPTTKeyCode(code: string): boolean {
  return pttKey.value === code
}

function handleKeyDown(event: KeyboardEvent): void {
  // If recording a new keybind, don't process as PTT
  if (isRecordingKeybind.value) {
    return
  }
  
  // Only process in PTT mode
  if (inputMode.value !== 'push_to_talk') {
    return
  }
  
  // Ignore if typing in an input field
  const target = event.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
    return
  }
  
  // Check if it's our PTT key (with correct modifiers)
  if (matchesPTTKey(event)) {
    event.preventDefault()
    event.stopPropagation()
    
    // Clear any pending release timer
    if (releaseTimer) {
      clearTimeout(releaseTimer)
      releaseTimer = null
    }
    
    // Activate PTT (unmute)
    if (!isPTTActive.value) {
      isPTTActive.value = true
      debug.log('🎤 [PTT] Key pressed - unmuting')
      onMuteCallback?.(false) // false = unmuted
    }
  }
}

function handleKeyUp(event: KeyboardEvent): void {
  // If recording a new keybind, don't process as PTT
  if (isRecordingKeybind.value) {
    return
  }
  
  // Only process in PTT mode
  if (inputMode.value !== 'push_to_talk') {
    return
  }
  
  // Check if it's our PTT key (we check just the base key on release, 
  // in case user releases modifier before the main key)
  if (event.code === pttKey.value && isPTTActive.value) {
    event.preventDefault()
    event.stopPropagation()
    
    // Add a small delay before muting to avoid cutting off words
    releaseTimer = setTimeout(() => {
      isPTTActive.value = false
      debug.log('🎤 [PTT] Key released - muting')
      onMuteCallback?.(true) // true = muted
      releaseTimer = null
    }, releaseDelay.value)
  }
}

// Handle window blur (user switches tabs/windows while holding PTT)
function handleWindowBlur(): void {
  if (isPTTActive.value && inputMode.value === 'push_to_talk') {
    isPTTActive.value = false
    debug.log('🎤 [PTT] Window lost focus - muting')
    onMuteCallback?.(true)
  }
}

// =============================================================================
// COMPOSABLE
// =============================================================================

export function usePushToTalk() {
  // Initialize settings on first use
  if (!isInitialized.value) {
    loadSettings()
  }
  
  // Computed
  const isPTTMode = computed(() => inputMode.value === 'push_to_talk')
  const isVoiceActivityMode = computed(() => inputMode.value === 'voice_activity')
  
  // Should the mic be muted? (for voice store to check)
  const shouldBeMuted = computed(() => {
    if (inputMode.value === 'voice_activity') {
      return false // Voice activity mode: never auto-mute based on PTT
    }
    return !isPTTActive.value // PTT mode: muted unless key is held
  })
  
  // Actions
  const setInputMode = (mode: InputMode): void => {
    inputMode.value = mode
    saveSettings()
    
    // If switching to PTT mode, start muted
    if (mode === 'push_to_talk') {
      isPTTActive.value = false
      onMuteCallback?.(true)
    }
    
    debug.log('🎤 [PTT] Input mode changed to:', mode)
  }
  
  const startRecordingKeybind = (): void => {
    isRecordingKeybind.value = true
    debug.log('🎤 [PTT] Recording keybind...')
  }
  
  const cancelRecordingKeybind = (): void => {
    isRecordingKeybind.value = false
    debug.log('🎤 [PTT] Cancelled keybind recording')
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
    
    // Record the key with modifiers
    pttKey.value = event.code
    pttKeyDisplay.value = keyEventToDisplay(event)
    pttModifiers.value = {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    }
    isRecordingKeybind.value = false
    saveSettings()
    
    debug.log('🎤 [PTT] Recorded keybind:', pttKey.value, pttKeyDisplay.value, 'modifiers:', pttModifiers.value)
    return true
  }
  
  const setReleaseDelay = (delay: number): void => {
    releaseDelay.value = Math.max(0, Math.min(1000, delay)) // Clamp to 0-1000ms
    saveSettings()
  }
  
  const resetToDefaults = (): void => {
    pttKey.value = DEFAULT_PTT_KEY
    pttKeyDisplay.value = DEFAULT_PTT_KEY_DISPLAY
    pttModifiers.value = { ctrl: false, alt: false, shift: false, meta: false }
    releaseDelay.value = DEFAULT_RELEASE_DELAY
    saveSettings()
  }
  
  /**
   * Check if a keyboard event should be blocked because it conflicts with PTT
   * Other components should call this to avoid handling shortcuts that are the PTT key
   */
  const shouldBlockShortcut = (event: KeyboardEvent): boolean => {
    // Only block if PTT mode is enabled
    if (inputMode.value !== 'push_to_talk') return false
    
    // Check if the key matches the PTT base key
    if (event.code !== pttKey.value) return false
    
    // If PTT has modifiers, only block when those exact modifiers are pressed
    const mods = pttModifiers.value
    const hasModifiers = mods.ctrl || mods.alt || mods.shift || mods.meta
    
    if (hasModifiers) {
      // Block only if exact modifier combination matches
      return matchesPTTKey(event)
    } else {
      // PTT has no modifiers - block the base key regardless of modifiers pressed
      // Actually, we should ONLY block if NO modifiers are pressed
      // If user presses Alt+V and PTT is just V, we should let Alt+V through
      return !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey
    }
  }
  
  /**
   * Register a callback to be called when mute state should change
   * This is called by the voice store to respond to PTT state changes
   */
  const registerMuteCallback = (callback: (muted: boolean) => void): void => {
    onMuteCallback = callback
  }
  
  /**
   * Unregister the mute callback
   */
  const unregisterMuteCallback = (): void => {
    onMuteCallback = null
  }
  
  // Setup global key listeners
  const setupListeners = (): void => {
    if (typeof window === 'undefined') return
    
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleWindowBlur)
    
    debug.log('🎤 [PTT] Global listeners registered')
  }
  
  const cleanupListeners = (): void => {
    if (typeof window === 'undefined') return
    
    window.removeEventListener('keydown', handleKeyDown)
    window.removeEventListener('keyup', handleKeyUp)
    window.removeEventListener('blur', handleWindowBlur)
    
    if (releaseTimer) {
      clearTimeout(releaseTimer)
      releaseTimer = null
    }
    
    debug.log('🎤 [PTT] Global listeners removed')
  }
  
  return {
    // State (readonly)
    inputMode: computed(() => inputMode.value),
    pttKey: computed(() => pttKey.value),
    pttKeyDisplay: computed(() => pttKeyDisplay.value),
    pttModifiers: computed(() => pttModifiers.value),
    releaseDelay: computed(() => releaseDelay.value),
    isPTTActive: computed(() => isPTTActive.value),
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

