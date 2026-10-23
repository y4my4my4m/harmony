// Appearance sync. A device either shares its look with the account (profiles.appearance_settings,
// the default) or keeps its own. The look is DEVICE_LOOK_KEYS; every other key of the visual
// settings (message display, links, emoticons, video player, accessibility aids besides contrast)
// is shared with the account either way.

import type { VisualThemeSettings } from '@/composables/useVisualTheme.types'

export const DEVICE_LOOK_KEYS = [
  'theme',
  'customThemeMode',
  'customPrimaryColor',
  'customAccentColor',
  'customBackgroundColor',
  'customSidebarColor',
  'customBackgroundLightness',
  'customBackgroundChroma',
  'customCssOverrides',
  'fontSize',
  'zoomLevel',
  'compactMode',
  'highContrast',
  'fontFamily',
  'glassEffectsEnabled',
  'activeSkinId',
  'customSkinCss',
  '_preSkinSnapshot',
  '_preSkinAudioTheme',
  'skinOptions',
] as const satisfies readonly (keyof VisualThemeSettings)[]

/** userStorage key; DEVICE_ONLY while this device keeps its own look, absent while synced. */
export const APPEARANCE_SYNC_KEY = 'appearance-sync'
export const DEVICE_ONLY = 'device'

/** The look keys present in `copy`. */
export function pickLook(copy: Partial<VisualThemeSettings>): Partial<VisualThemeSettings> {
  const look: Record<string, unknown> = {}
  for (const key of DEVICE_LOOK_KEYS) {
    if (key in copy) look[key] = copy[key]
  }
  return look as Partial<VisualThemeSettings>
}

/**
 * The account copy written by a device that keeps its own look: this device's other settings
 * with the account's look. Look keys the account copy lacks are dropped, not filled from the
 * device. Without an account copy, the device's look stands.
 */
export function accountCopyFor<T extends Partial<VisualThemeSettings>>(
  device: T,
  account: Partial<VisualThemeSettings> | null,
): T {
  if (!account) return device
  const out: Record<string, unknown> = { ...device }
  for (const key of DEVICE_LOOK_KEYS) delete out[key]
  return { ...out, ...pickLook(account) } as T
}
