// Bridge to the Rust global-input PTT helper (src-tauri/src/commands/ptt.rs).
// Only the press state of the single bound key crosses the boundary — no keystrokes.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauriDesktop } from '@/utils/platform'
import { debug } from '@/utils/debug'
import type { KeybindModifiers } from '@/composables/useKeybinds'

export interface NativePttBinding {
  key: string
  modifiers: KeybindModifiers
}

let stateUnlisten: UnlistenFn | null = null
let failUnlisten: UnlistenFn | null = null
let onStateChange: ((pressed: boolean) => void) | null = null
let onCaptureFailed: (() => void) | null = null

export async function armNativePtt(
  binding: NativePttBinding,
  onState: (pressed: boolean) => void,
  onUnavailable: () => void,
): Promise<boolean> {
  if (!isTauriDesktop()) return false

  onStateChange = onState
  onCaptureFailed = onUnavailable

  try {
    if (!stateUnlisten) {
      stateUnlisten = await listen<boolean>('ptt://state', (event) => onStateChange?.(event.payload))
    }
    if (!failUnlisten) {
      failUnlisten = await listen('ptt://unavailable', () => onCaptureFailed?.())
    }

    return await invoke<boolean>('ptt_set_binding', {
      binding: {
        key: binding.key,
        ctrl: binding.modifiers.ctrl,
        alt: binding.modifiers.alt,
        shift: binding.modifiers.shift,
        meta: binding.modifiers.meta,
      },
    })
  } catch (error) {
    debug.warn('⌨[NativePTT] arm failed:', error)
    return false
  }
}

export async function disarmNativePtt(): Promise<void> {
  if (!isTauriDesktop()) return

  onStateChange = null
  onCaptureFailed = null

  try {
    await invoke('ptt_set_binding', { binding: null })
  } catch (error) {
    debug.warn('⌨[NativePTT] disarm failed:', error)
  }
}
