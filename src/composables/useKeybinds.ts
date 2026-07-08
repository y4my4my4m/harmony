/**
 * Centralized Keybind Management System
 * 
 * Provides a professional, unified approach to keyboard shortcuts.
 * All keybinds are defined here, customizable, and handled through
 * a single global listener.
 * 
 * Features:
 * - Centralized keybind definitions
 * - Customizable keybinds stored in localStorage
 * - Modifier key support (Ctrl, Alt, Shift, Meta)
 * - Context-aware shortcuts (global vs scoped)
 * - Conflict detection and priority handling
 * - PTT integration
 */

import { ref, computed, readonly } from 'vue'
import { debug } from '@/utils/debug'
import { armNativePtt, disarmNativePtt } from '@/services/nativePtt'
import { isTauriDesktop } from '@/utils/platform'

// TYPES

export interface KeybindModifiers {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

export interface KeybindDefinition {
  id: string
  name: string
  description: string
  category: KeybindCategory
  defaultKey: string
  defaultModifiers: KeybindModifiers
  // Current customized values
  key: string
  modifiers: KeybindModifiers
  // Whether this keybind is enabled
  enabled: boolean
  // Context in which this keybind is active
  context: KeybindContext
  // Whether the key must be held (like PTT) vs pressed once
  holdMode: boolean
}

export type KeybindCategory = 
  | 'global'      // Always active
  | 'voice'       // Active during voice calls
  | 'chat'        // Active in chat view
  | 'navigation'  // Navigation shortcuts

export type KeybindContext =
  | 'global'           // Works everywhere
  | 'voice-connected'  // Only when in a voice channel
  | 'voice-overlay'    // Only when voice overlay is open
  | 'chat-focused'     // Only when chat input is NOT focused

export type KeybindAction =
  | 'push-to-talk'
  | 'toggle-mute'
  | 'toggle-deafen'
  | 'toggle-camera'
  | 'toggle-screenshare'
  | 'toggle-voice-settings'
  | 'exit-fullscreen'
  | 'minimize-overlay'

// Handler types
type KeybindHandler = () => void
type HoldKeyHandler = (isPressed: boolean) => void

// CONSTANTS

const STORAGE_KEY = 'harmony-keybinds'

const NO_MODIFIERS: KeybindModifiers = { ctrl: false, alt: false, shift: false, meta: false }

// Default keybind definitions
const DEFAULT_KEYBINDS: Record<KeybindAction, Omit<KeybindDefinition, 'key' | 'modifiers'>> = {
  'push-to-talk': {
    id: 'push-to-talk',
    name: 'Push to Talk',
    description: 'Hold to transmit audio in voice channels',
    category: 'voice',
    defaultKey: 'KeyV',
    defaultModifiers: NO_MODIFIERS,
    enabled: true,
    context: 'voice-connected',
    holdMode: true,
  },
  'toggle-mute': {
    id: 'toggle-mute',
    name: 'Toggle Mute',
    description: 'Mute or unmute your microphone',
    category: 'voice',
    defaultKey: 'KeyM',
    defaultModifiers: NO_MODIFIERS,
    enabled: true,
    context: 'voice-connected',
    holdMode: false,
  },
  'toggle-deafen': {
    id: 'toggle-deafen',
    name: 'Toggle Deafen',
    description: 'Deafen or undeafen yourself',
    category: 'voice',
    defaultKey: 'KeyD',
    defaultModifiers: NO_MODIFIERS,
    enabled: true,
    context: 'voice-connected',
    holdMode: false,
  },
  'toggle-camera': {
    id: 'toggle-camera',
    name: 'Toggle Camera',
    description: 'Turn your camera on or off',
    category: 'voice',
    defaultKey: 'KeyV',
    defaultModifiers: NO_MODIFIERS,
    enabled: true,
    context: 'voice-overlay',
    holdMode: false,
  },
  'toggle-screenshare': {
    id: 'toggle-screenshare',
    name: 'Toggle Screen Share',
    description: 'Start or stop screen sharing',
    category: 'voice',
    defaultKey: 'KeyS',
    defaultModifiers: NO_MODIFIERS,
    enabled: true,
    context: 'voice-overlay',
    holdMode: false,
  },
  'toggle-voice-settings': {
    id: 'toggle-voice-settings',
    name: 'Voice Settings',
    description: 'Open voice settings panel',
    category: 'voice',
    defaultKey: 'Comma',
    defaultModifiers: NO_MODIFIERS,
    enabled: true,
    context: 'voice-overlay',
    holdMode: false,
  },
  'exit-fullscreen': {
    id: 'exit-fullscreen',
    name: 'Exit/Close',
    description: 'Exit fullscreen or close panels',
    category: 'voice',
    defaultKey: 'Escape',
    defaultModifiers: NO_MODIFIERS,
    enabled: true,
    context: 'voice-overlay',
    holdMode: false,
  },
  'minimize-overlay': {
    id: 'minimize-overlay',
    name: 'Minimize Overlay',
    description: 'Minimize the voice overlay',
    category: 'voice',
    defaultKey: 'Escape',
    defaultModifiers: NO_MODIFIERS,
    enabled: true,
    context: 'voice-overlay',
    holdMode: false,
  },
}

// STATE (Singleton)

const keybinds = ref<Map<KeybindAction, KeybindDefinition>>(new Map())
const handlers = ref<Map<KeybindAction, KeybindHandler | HoldKeyHandler>>(new Map())
const holdState = ref<Map<KeybindAction, boolean>>(new Map()) // Track held keys
const activeContexts = ref<Set<KeybindContext>>(new Set(['global']))
const isInitialized = ref(false)
const isListenerSetup = ref(false)

// Input mode for voice (voice_activity vs push_to_talk)
const inputMode = ref<'voice_activity' | 'push_to_talk'>('voice_activity')
const releaseDelay = ref(200) // ms

// Debounce timer for hold release
const releaseTimers: Map<KeybindAction, ReturnType<typeof setTimeout>> = new Map()

// Native (OS-level) PTT capture — armed on Tauri desktop so PTT works while unfocused
const nativeCaptureActive = ref(false)
const nativePttAvailable = ref<boolean | null>(null)
let nativeArmToken = 0

// HELPERS

/**
 * Mouse button name mappings
 */
const MOUSE_BUTTON_NAMES: Record<string, string> = {
  'Mouse0': 'Left Click',
  'Mouse1': 'Middle Click',
  'Mouse2': 'Right Click',
  'Mouse3': 'Mouse 4 (Back)',
  'Mouse4': 'Mouse 5 (Forward)',
  'Mouse5': 'Mouse 6',
  'Mouse6': 'Mouse 7',
  'Mouse7': 'Mouse 8',
}

/**
 * Check if a key code is a mouse button
 */
function isMouseButton(key: string): boolean {
  return key.startsWith('Mouse')
}

/**
 * Convert key code to display string
 */
function keyToDisplay(key: string, modifiers: KeybindModifiers): string {
  const parts: string[] = []
  
  if (modifiers.ctrl) parts.push('Ctrl')
  if (modifiers.alt) parts.push('Alt')
  if (modifiers.shift) parts.push('Shift')
  if (modifiers.meta) parts.push('Meta')
  
  if (isMouseButton(key)) {
    parts.push(MOUSE_BUTTON_NAMES[key] || key)
    return parts.join(' + ')
  }
  
  let keyName = key
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
    keyName = keyName.slice(3)
  } else if (keyName.startsWith('Digit')) {
    keyName = keyName.slice(5)
  } else if (keyName.startsWith('Numpad')) {
    keyName = 'Num' + keyName.slice(6)
  }
  
  parts.push(keyName)
  return parts.join(' + ')
}

/**
 * Check if event matches a keybind
 */
function matchesKeybind(event: KeyboardEvent, keybind: KeybindDefinition): boolean {
  if (event.code !== keybind.key) return false
  
  return (
    event.ctrlKey === keybind.modifiers.ctrl &&
    event.altKey === keybind.modifiers.alt &&
    event.shiftKey === keybind.modifiers.shift &&
    event.metaKey === keybind.modifiers.meta
  )
}

/**
 * Check if context is currently active
 */
function isContextActive(context: KeybindContext): boolean {
  if (context === 'global') return true
  return activeContexts.value.has(context)
}

/**
 * Check if the event originated from a text-entry element
 */
function isTypingTarget(event: Event): boolean {
  const target = event.target as HTMLElement | null
  if (!target) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

// HOLD-MODE CORE — single path for all input sources (keyboard, mouse, native capture, touch)

function pressHold(action: KeybindAction): void {
  const timer = releaseTimers.get(action)
  if (timer) {
    clearTimeout(timer)
    releaseTimers.delete(action)
  }
  if (holdState.value.get(action)) return
  holdState.value.set(action, true)
  const handler = handlers.value.get(action)
  if (handler) (handler as HoldKeyHandler)(true)
  debug.log(`⌨[Keybinds] ${action} hold start`)
}

function releaseHold(action: KeybindAction, immediate = false): void {
  if (!holdState.value.get(action)) return
  const existing = releaseTimers.get(action)
  if (existing) clearTimeout(existing)
  const finish = (): void => {
    releaseTimers.delete(action)
    holdState.value.set(action, false)
    const handler = handlers.value.get(action)
    if (handler) (handler as HoldKeyHandler)(false)
    debug.log(`⌨[Keybinds] ${action} hold end`)
  }
  if (immediate || releaseDelay.value <= 0) {
    finish()
    return
  }
  releaseTimers.set(action, setTimeout(finish, releaseDelay.value))
}

// INITIALIZATION

function initializeKeybinds(): void {
  if (isInitialized.value) return
  
  for (const [action, def] of Object.entries(DEFAULT_KEYBINDS)) {
    keybinds.value.set(action as KeybindAction, {
      ...def,
      key: def.defaultKey,
      modifiers: { ...def.defaultModifiers },
    })
  }
  
  loadKeybinds()
  
  isInitialized.value = true
  debug.log('⌨[Keybinds] Initialized with', keybinds.value.size, 'keybinds')
}

function loadKeybinds(): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const data = JSON.parse(stored)
      
      if (data.inputMode) {
        inputMode.value = data.inputMode
      }
      if (data.releaseDelay !== undefined) {
        releaseDelay.value = data.releaseDelay
      }
      
      if (data.keybinds) {
        for (const [action, custom] of Object.entries(data.keybinds)) {
          const keybind = keybinds.value.get(action as KeybindAction)
          if (keybind && custom) {
            const customData = custom as { key?: string; modifiers?: KeybindModifiers; enabled?: boolean }
            if (customData.key) keybind.key = customData.key
            if (customData.modifiers) keybind.modifiers = { ...customData.modifiers }
            if (customData.enabled !== undefined) keybind.enabled = customData.enabled
          }
        }
      }
      
      debug.log('⌨[Keybinds] Loaded customizations from storage')
    }
  } catch (error) {
    debug.warn('⌨[Keybinds] Failed to load from storage:', error)
  }
}

function saveKeybinds(): void {
  try {
    const data: Record<string, any> = {
      inputMode: inputMode.value,
      releaseDelay: releaseDelay.value,
      keybinds: {},
    }
    
    // Only save customized keybinds (those different from defaults)
    for (const [action, keybind] of keybinds.value.entries()) {
      const def = DEFAULT_KEYBINDS[action]
      if (
        keybind.key !== def.defaultKey ||
        JSON.stringify(keybind.modifiers) !== JSON.stringify(def.defaultModifiers) ||
        keybind.enabled !== def.enabled
      ) {
        data.keybinds[action] = {
          key: keybind.key,
          modifiers: keybind.modifiers,
          enabled: keybind.enabled,
        }
      }
    }
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    debug.log('⌨[Keybinds] Saved to storage')
  } catch (error) {
    debug.warn('⌨[Keybinds] Failed to save to storage:', error)
  }
}

// EVENT HANDLERS

function handleKeyDown(event: KeyboardEvent): void {
  const typing = isTypingTarget(event)

  // Check each keybind
  for (const [action, keybind] of keybinds.value.entries()) {
    if (!keybind.enabled) continue
    if (!isContextActive(keybind.context)) continue
    if (!matchesKeybind(event, keybind)) continue

    // While typing only hold-mode binds (PTT) and Escape stay live, like Discord
    if (typing && !keybind.holdMode && event.code !== 'Escape') continue

    // Special handling for PTT in voice_activity mode
    if (action === 'push-to-talk' && inputMode.value !== 'push_to_talk') {
      continue // Skip PTT when not in PTT mode
    }

    // Special handling for toggle-camera when PTT uses same key
    if (action === 'toggle-camera' && inputMode.value === 'push_to_talk') {
      const pttKeybind = keybinds.value.get('push-to-talk')
      if (pttKeybind && matchesKeybind(event, pttKeybind)) {
        continue // PTT takes priority
      }
    }

    const handler = handlers.value.get(action)
    if (!handler) continue

    // Don't eat the character while typing — PTT transmits AND types (Discord behavior)
    if (!typing || event.code === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
    }

    if (keybind.holdMode) {
      pressHold(action)
    } else {
      ;(handler as KeybindHandler)()
      debug.log(`⌨[Keybinds] ${action} triggered`)
    }

    return // Only handle first matching keybind
  }
}

function handleKeyUp(event: KeyboardEvent): void {
  // Check hold-mode keybinds
  for (const [action, keybind] of keybinds.value.entries()) {
    if (!keybind.holdMode) continue
    if (!keybind.enabled) continue
    if (!holdState.value.get(action)) continue

    if (event.code !== keybind.key) continue

    if (!isTypingTarget(event)) {
      event.preventDefault()
      event.stopPropagation()
    }

    releaseHold(action)
  }
}

function handleWindowBlur(): void {
  for (const [action, isHeld] of holdState.value.entries()) {
    if (!isHeld) continue
    // Native capture keeps PTT alive while the window is unfocused
    if (action === 'push-to-talk' && nativeCaptureActive.value) continue
    releaseHold(action, true)
  }
}

// MOUSE EVENT HANDLERS

function handleMouseDown(event: MouseEvent): void {
  // Only handle extra buttons (3, 4, 5, etc.) - not left/right/middle click for normal use
  // But we DO handle them if they're explicitly bound
  const mouseKey = `Mouse${event.button}`
  
  // Check each keybind
  for (const [action, keybind] of keybinds.value.entries()) {
    if (!keybind.enabled) continue
    if (!isContextActive(keybind.context)) continue
    if (keybind.key !== mouseKey) continue
    
    // Check modifiers
    const modifiersMatch = (
      event.ctrlKey === keybind.modifiers.ctrl &&
      event.altKey === keybind.modifiers.alt &&
      event.shiftKey === keybind.modifiers.shift &&
      event.metaKey === keybind.modifiers.meta
    )
    if (!modifiersMatch) continue
    
    // Special handling for PTT in voice_activity mode
    if (action === 'push-to-talk' && inputMode.value !== 'push_to_talk') {
      continue
    }
    
    event.preventDefault()
    event.stopPropagation()
    
    const handler = handlers.value.get(action)
    if (!handler) continue
    
    if (keybind.holdMode) {
      pressHold(action)
    } else {
      ;(handler as KeybindHandler)()
      debug.log(`[Keybinds] ${action} mouse triggered`)
    }

    return // Only handle first matching keybind
  }
}

function handleMouseUp(event: MouseEvent): void {
  const mouseKey = `Mouse${event.button}`

  // Check hold-mode keybinds
  for (const [action, keybind] of keybinds.value.entries()) {
    if (!keybind.holdMode) continue
    if (!keybind.enabled) continue
    if (!holdState.value.get(action)) continue
    if (keybind.key !== mouseKey) continue

    event.preventDefault()
    event.stopPropagation()

    releaseHold(action)
  }
}

// Native capture (Tauri desktop): armed only in voice + PTT mode; Rust reports press state for the bound key only, so PTT works unfocused
function syncNativeCapture(): void {
  if (!isTauriDesktop()) return

  const keybind = keybinds.value.get('push-to-talk')
  const wanted =
    isListenerSetup.value &&
    activeContexts.value.has('voice-connected') &&
    inputMode.value === 'push_to_talk' &&
    !!keybind?.enabled

  const token = ++nativeArmToken
  if (!wanted) {
    if (nativeCaptureActive.value) {
      nativeCaptureActive.value = false
      void disarmNativePtt()
      releaseHold('push-to-talk')
    }
    return
  }

  void armNativePtt(
    { key: keybind!.key, modifiers: keybind!.modifiers },
    (pressed) => (pressed ? pressHold('push-to-talk') : releaseHold('push-to-talk')),
    () => {
      // capture backend died (e.g. macOS accessibility denied) — window listeners still work
      nativeCaptureActive.value = false
      nativePttAvailable.value = false
    },
  ).then((supported) => {
    if (token !== nativeArmToken) return
    nativePttAvailable.value = supported
    nativeCaptureActive.value = supported
    debug.log(`⌨[Keybinds] Native PTT capture ${supported ? 'armed' : 'unavailable'}`)
  })
}

// COMPOSABLE

export function useKeybinds() {
  // Initialize on first use
  if (!isInitialized.value) {
    initializeKeybinds()
  }
  
  // Computed
  const allKeybinds = computed(() => Array.from(keybinds.value.values()))
  const voiceKeybinds = computed(() => allKeybinds.value.filter(k => k.category === 'voice'))
  const isPTTMode = computed(() => inputMode.value === 'push_to_talk')
  const isVoiceActivityMode = computed(() => inputMode.value === 'voice_activity')
  
  const getKeybind = (action: KeybindAction): KeybindDefinition | undefined => {
    return keybinds.value.get(action)
  }
  
  const getKeybindDisplay = (action: KeybindAction): string => {
    const keybind = keybinds.value.get(action)
    if (!keybind) return 'Not set'
    return keyToDisplay(keybind.key, keybind.modifiers)
  }
  
  const registerHandler = (action: KeybindAction, handler: KeybindHandler | HoldKeyHandler): void => {
    handlers.value.set(action, handler)
  }
  
  // Unregister handler
  const unregisterHandler = (action: KeybindAction): void => {
    handlers.value.delete(action)
  }
  
  const setKeybind = (action: KeybindAction, key: string, modifiers: KeybindModifiers): void => {
    const keybind = keybinds.value.get(action)
    if (keybind) {
      keybind.key = key
      keybind.modifiers = { ...modifiers }
      saveKeybinds()
      syncNativeCapture()
      debug.log(`⌨[Keybinds] Updated ${action} to ${keyToDisplay(key, modifiers)}`)
    }
  }

  const resetKeybind = (action: KeybindAction): void => {
    const keybind = keybinds.value.get(action)
    const def = DEFAULT_KEYBINDS[action]
    if (keybind && def) {
      keybind.key = def.defaultKey
      keybind.modifiers = { ...def.defaultModifiers }
      keybind.enabled = def.enabled
      saveKeybinds()
      syncNativeCapture()
    }
  }
  
  const resetAllKeybinds = (): void => {
    for (const action of Object.keys(DEFAULT_KEYBINDS) as KeybindAction[]) {
      resetKeybind(action)
    }
  }
  
  const toggleKeybindEnabled = (action: KeybindAction): void => {
    const keybind = keybinds.value.get(action)
    if (keybind) {
      keybind.enabled = !keybind.enabled
      saveKeybinds()
      syncNativeCapture()
    }
  }

  const setInputMode = (mode: 'voice_activity' | 'push_to_talk'): void => {
    inputMode.value = mode
    saveKeybinds()
    syncNativeCapture()
    debug.log(`⌨[Keybinds] Input mode set to ${mode}`)
  }
  
  const setReleaseDelay = (delay: number): void => {
    releaseDelay.value = Math.max(0, Math.min(1000, delay))
    saveKeybinds()
  }
  
  // Activate a context
  const activateContext = (context: KeybindContext): void => {
    activeContexts.value.add(context)
    syncNativeCapture()
  }

  // Deactivate a context
  const deactivateContext = (context: KeybindContext): void => {
    activeContexts.value.delete(context)
    syncNativeCapture()
  }
  
  const matchesEvent = (action: KeybindAction, event: KeyboardEvent): boolean => {
    const keybind = keybinds.value.get(action)
    if (!keybind || !keybind.enabled) return false
    return matchesKeybind(event, keybind)
  }
  
  // Check if a keyboard event should be blocked because it matches an active keybind
  const shouldBlockShortcut = (event: KeyboardEvent, excludeActions?: KeybindAction[]): boolean => {
    for (const [action, keybind] of keybinds.value.entries()) {
      if (!keybind.enabled) continue
      if (excludeActions?.includes(action)) continue
      if (!isContextActive(keybind.context)) continue
      
      // Special handling for PTT
      if (action === 'push-to-talk' && inputMode.value !== 'push_to_talk') {
        continue
      }
      
      if (matchesKeybind(event, keybind)) {
        return true
      }
    }
    return false
  }
  
  const isPTTActive = computed(() => holdState.value.get('push-to-talk') ?? false)
  
  const setupListeners = (): void => {
    if (isListenerSetup.value) return
    if (typeof window === 'undefined') return
    
    // Keyboard events
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    window.addEventListener('keyup', handleKeyUp, { capture: true })
    
    // Mouse events (for mouse button keybinds)
    window.addEventListener('mousedown', handleMouseDown, { capture: true })
    window.addEventListener('mouseup', handleMouseUp, { capture: true })
    
    // Window blur
    window.addEventListener('blur', handleWindowBlur)
    
    isListenerSetup.value = true
    syncNativeCapture()
    debug.log('⌨[Keybinds] Global listeners registered (keyboard + mouse)')
  }
  
  const cleanupListeners = (): void => {
    if (!isListenerSetup.value) return
    if (typeof window === 'undefined') return
    
    // Keyboard events
    window.removeEventListener('keydown', handleKeyDown, { capture: true })
    window.removeEventListener('keyup', handleKeyUp, { capture: true })
    
    // Mouse events
    window.removeEventListener('mousedown', handleMouseDown, { capture: true })
    window.removeEventListener('mouseup', handleMouseUp, { capture: true })
    
    // Window blur
    window.removeEventListener('blur', handleWindowBlur)
    
    isListenerSetup.value = false
    syncNativeCapture()

    for (const timer of releaseTimers.values()) {
      clearTimeout(timer)
    }
    releaseTimers.clear()

    debug.log('⌨[Keybinds] Global listeners removed')
  }
  
  return {
    // State (readonly)
    allKeybinds,
    voiceKeybinds,
    inputMode: readonly(inputMode),
    releaseDelay: readonly(releaseDelay),
    activeContexts: readonly(activeContexts),
    isPTTActive,
    nativePttAvailable: readonly(nativePttAvailable),
    nativeCaptureActive: readonly(nativeCaptureActive),

    // Computed
    isPTTMode,
    isVoiceActivityMode,
    
    // Getters
    getKeybind,
    getKeybindDisplay,
    matchesEvent,
    shouldBlockShortcut,
    
    // Actions
    registerHandler,
    unregisterHandler,
    pressHold,
    releaseHold,
    setKeybind,
    resetKeybind,
    resetAllKeybinds,
    toggleKeybindEnabled,
    setInputMode,
    setReleaseDelay,
    activateContext,
    deactivateContext,
    
    // Lifecycle
    setupListeners,
    cleanupListeners,
  }
}

