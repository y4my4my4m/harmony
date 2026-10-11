import type { KeybindAction } from '@/composables/useKeybinds'

type Translate = (key: string, ...args: unknown[]) => string

// Locale keys are camelCase; vue-i18n paths do not take the action ids' hyphens.
const LOCALE_KEY: Record<KeybindAction, string> = {
  'push-to-talk': 'pushToTalk',
  'toggle-mute': 'toggleMute',
  'toggle-deafen': 'toggleDeafen',
  'toggle-camera': 'toggleCamera',
  'toggle-screenshare': 'toggleScreenshare',
  'toggle-voice-settings': 'toggleVoiceSettings',
  'exit-fullscreen': 'exitFullscreen',
  'minimize-overlay': 'exitFullscreen',
}

/** Keybinds listed in Settings › Keybinds, in display order. */
export const LISTED_KEYBINDS: KeybindAction[] = [
  'push-to-talk',
  'toggle-mute',
  'toggle-deafen',
  'toggle-camera',
  'toggle-screenshare',
  'toggle-voice-settings',
  'exit-fullscreen',
]

export const keybindName = (t: Translate, action: KeybindAction): string =>
  t(`settings.keybinds.actions.${LOCALE_KEY[action]}.name`)

export const keybindDescription = (t: Translate, action: KeybindAction): string =>
  t(`settings.keybinds.actions.${LOCALE_KEY[action]}.description`)
