/**
 * Standalone type module for `useVisualTheme`. Extracted so skin modules
 * under `./skins/` can import the settings shape without pulling in the
 * full composable (which itself imports the skin registry, creating a
 * circular dependency otherwise).
 */

export interface VisualThemeSettings {
  theme: 'dark' | 'light' | 'midnight' | 'custom'
  customThemeMode?: 'dark' | 'light'
  customPrimaryColor?: string
  customAccentColor?: string
  customBackgroundColor?: string
  /**
   * Optional second background hue applied to the structural "sidebar" surfaces
   * (server rail, channel sidebar, member list - the secondary/tertiary tiers).
   * When unset, those surfaces are derived from `customBackgroundColor` like
   * before (single-colour mode). When set, only their hue/tint changes; tier
   * lightness relationships are preserved so elevation/contrast stays intact.
   */
  customSidebarColor?: string
  customBackgroundLightness?: number // -50 to +50
  customBackgroundChroma?: number // -30 to +30
  customCssOverrides?: Record<string, string>
  fontSize: number
  zoomLevel: number
  showTimestamps: boolean
  use24HourTime: boolean
  compactMode: boolean
  highContrast: boolean
  reduceMotion: boolean
  screenReaderSupport: boolean
  /** Show custom emojis in other users' display names. Instance must allow it too. */
  showCustomEmojisInDisplayNames?: boolean
  /**
   * Render `>foo` lines (no space after `>`) as imageboard-style greentext in
   * chat/DM messages. `> foo` is always a blockquote regardless of this flag.
   * Default: true (opt-out).
   */
  greentextEnabled?: boolean
  /**
   * UI typeface. `'system'` uses Figtree + native fallbacks (the default
   * Harmony look). `'pixel'` switches to NoRe Sans Pixel Pro v2, an original
   * pixel-style Latin webfont. Persisted alongside the rest of the visual
   * theme via the `appearance_settings` JSONB column on `profiles`, so the
   * choice syncs across devices automatically.
   */
  fontFamily?: 'system' | 'pixel'
  /**
   * Enable backdrop-filter blur and glass-like translucency across the UI.
   * When `false`, sets `data-disable-blur` on `:root` (the CSS hook keeps
   * its negative name as an internal implementation detail - see
   * `design-system.css`) which a global rule uses to neutralise every
   * `backdrop-filter` / `-webkit-backdrop-filter` declaration.
   * Default is `true` (effects enabled).
   */
  glassEffectsEnabled?: boolean
  /**
   * Active skin id. Skins are bundles of theme overrides + CSS that go
   * beyond simple colour switching. `null` (default) means "no skin".
   */
  activeSkinId?: string | null
  /**
   * Raw CSS injected globally by the active skin. Set by `applySkin`,
   * cleared by `clearSkin`. Do NOT edit by hand.
   */
  customSkinCss?: string
  /**
   * Snapshot of skin-affected keys captured when a skin is applied so
   * `clearSkin` can restore them after reloads / cross-device sync.
   * Set by `applySkin`, consumed by `clearSkin`. Do NOT edit by hand.
   */
  _preSkinSnapshot?: Partial<VisualThemeSettings>
  /**
   * Audio theme id captured when a skin with a linked sound pack is applied,
   * so `clearSkin` can restore the user's prior selection. Persisted in
   * `appearance_settings` alongside the skin. Do NOT edit by hand.
   */
  _preSkinAudioTheme?: string
  /**
   * Per-skin user-toggleable option values. Shape:
   * `{ [skinId]: { [optionId]: boolean } }`. When a skin is active, each
   * stored value (or its declared default if absent) is written to
   * `<html data-skin-<optionId>="on|off">` so skin CSS can gate rules
   * declaratively. Persisted across devices via `appearance_settings`.
   */
  skinOptions?: Record<string, Record<string, boolean>>
  /**
   * How bridged message authors show their source in chat headers.
   * `icon` = platform icon (default); `text` = label badge e.g. DISCORD.
   */
  bridgeSourceBadge?: 'icon' | 'text'
  /** Blurred server banner behind the invite dialog. Default: true (opt-out). */
  inviteBannerBackground?: boolean
}
