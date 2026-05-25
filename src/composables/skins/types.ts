/**
 * Skin shape shared by every skin under `src/composables/skins/<id>/`.
 * Re-exported from `useVisualTheme.ts` for backward compatibility with
 * existing imports.
 */
import type { VisualThemeSettings } from '../useVisualTheme.types'

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
}
