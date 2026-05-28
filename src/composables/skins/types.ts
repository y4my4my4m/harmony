/**
 * Skin shape shared by every skin under `src/composables/skins/<id>/`.
 * Re-exported from `useVisualTheme.ts` for backward compatibility with
 * existing imports.
 */
import type { VisualThemeSettings } from '../useVisualTheme.types'

/**
 * A user-toggleable decorative knob exposed by a skin under
 * Appearance > Skins. Active option values are written to the root
 * element as `data-skin-<id>="on" | "off"` so skin CSS can gate rules
 * declaratively (no JS branching anywhere). Boolean-only for now;
 * the type field is kept as a discriminator so future option kinds
 * (numeric sliders, enums) extend cleanly.
 */
export interface SkinOption {
  /** Stable id, used in `data-skin-<id>` and persistence. kebab-case. */
  id: string
  /** Short label for the toggle in Appearance > Skins. */
  label: string
  /** Optional one-line explainer below the label. */
  description?: string
  /** Discriminator for future option kinds. Only `boolean` for now. */
  type: 'boolean'
  /** Default value applied when the user has no stored preference. */
  default: boolean
}

export interface Skin {
  /** Stable id used in `data-skin="..."` selectors and `appearance_settings`. */
  id: string
  /** Human-readable name for the picker. */
  name: string
  /** One-paragraph picker description. */
  description: string
  /** When true, picker shows a "Beta" badge. */
  isBeta?: boolean
  /** Preview image path (relative to /public). */
  preview?: string
  /** Theme-system fields the skin merges into the live settings on apply. */
  themeOverrides: Partial<VisualThemeSettings>
  /**
   * Raw CSS injected into a single global `<style id="harmony-skin-styles">`
   * element. Should be scoped under `[data-skin="<id>"]` so picking a
   * different skin (or "None") removes every rule cleanly.
   */
  globalCss?: string
  /**
   * Optional decorative toggles exposed in Appearance > Skins. Skin CSS
   * gates its decorative rules on `data-skin-<id>="on"` so users can
   * disable scanlines / HUD chrome / etc. while keeping the skin's core
   * paint. Empty / absent = no options, picker shows just the card.
   */
  options?: SkinOption[]
  /**
   * Audio theme id auto-applied with the skin (and reverted to the
   * pre-skin selection by `clearSkin`). Replaces the previously
   * hardcoded `SKIN_LINKED_AUDIO_THEMES` map in `useVisualTheme.ts`,
   * keeping skin metadata in one place.
   */
  linkedAudioTheme?: string
}
