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

/**
 * A running scene: script-driven layers a stylesheet cannot express (canvas
 * rendering, pointer tracking). Mounted while its skin is active, destroyed
 * when the skin changes or clears.
 */
export interface SkinScene {
  /** Current option values, `{ [optionId]: boolean }`. Called on mount and on every option change. */
  update(options: Record<string, boolean>): void
  /** Removes every node, listener and inline property the scene added. */
  destroy(): void
}

export type SkinSceneFactory = () => SkinScene

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
   * Resolves the skin's stylesheet text, injected into a single global
   * `<style id="harmony-skin-styles">` element. A dynamic `import()` of
   * `./skin.css?raw`, so the CSS ships as its own chunk and is fetched only
   * once the skin is active. Scope rules under `[data-skin="<id>"]` so picking
   * a different skin (or "None") disables every rule.
   */
  loadCss?: () => Promise<string>
  /**
   * Resolves the skin's scene factory, a dynamic `import()` like `loadCss`.
   * Absent for skins that are stylesheet only.
   */
  loadScene?: () => Promise<SkinSceneFactory>
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
