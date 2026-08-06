/**
 * Skin shape shared by every skin under `src/composables/skins/<id>/`.
 * Re-exported from `useVisualTheme.ts` for backward compatibility with
 * existing imports.
 */
import type { VisualThemeSettings } from '../useVisualTheme.types'

/**
 * Decorative toggle exposed by a skin under Appearance > Skins. Active
 * option values are written to the root element as
 * `data-skin-<id>="on" | "off"`; skin CSS gates rules on that attribute,
 * with no JS branching. Boolean is the only option kind.
 */
export interface SkinOption {
  /** Stable id, used in `data-skin-<id>` and persistence. kebab-case. */
  id: string
  /** Short label for the toggle in Appearance > Skins. */
  label: string
  /** Optional one-line explainer below the label. */
  description?: string
  /** Option-kind discriminator. `boolean` is the only kind. */
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
   * element. Scope under `[data-skin="<id>"]` so picking a different skin
   * (or "None") removes every rule.
   */
  globalCss?: string
  /**
   * Decorative toggles exposed in Appearance > Skins. Skin CSS gates
   * decorative rules on `data-skin-<id>="on"`, leaving the skin's core
   * paint intact when off. Empty or absent: picker shows only the card.
   */
  options?: SkinOption[]
  /**
   * Audio theme id applied with the skin. `clearSkin` reverts it to the
   * pre-skin selection.
   */
  linkedAudioTheme?: string
}
