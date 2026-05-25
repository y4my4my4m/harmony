/**
 * Visual Theme Composable
 * 
 * Manages visual theme settings including:
 * - Preset themes (dark, light, midnight)
 * - Custom OKLCH-based themes
 * - Real-time theme application
 * - Persistence to localStorage and Supabase
 */

import { ref, computed, watch } from 'vue'
import { generateThemePalette, applyThemePalette, type ThemePalette } from '@/utils/colorUtils'
import { supabase } from '@/supabase'
import { useAuthStore } from '@/stores/auth'
import { useProfileStore } from '@/stores/useProfile'
import { debug } from '@/utils/debug'
import { userStorage } from '@/utils/userScopedStorage'

export interface VisualThemeSettings {
  theme: 'dark' | 'light' | 'midnight' | 'custom'
  customThemeMode?: 'dark' | 'light'
  customPrimaryColor?: string
  customAccentColor?: string
  customBackgroundColor?: string
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
   * Disable backdrop-filter blur and glass-like translucency across the UI.
   * When `true`, sets `data-disable-blur` on `:root` which a global rule in
   * `design-system.css` uses to neutralise every `backdrop-filter` /
   * `-webkit-backdrop-filter` declaration. Useful for low-end devices or for
   * users who prefer flat / sharper UIs (also a hard requirement for the
   * SDR-001 skin which is intentionally crisp).
   */
  disableGlassBlur?: boolean
  /**
   * Active skin id. Skins are bundles of theme overrides + CSS that go
   * beyond simple colour switching - sharp corners, scanline overlays,
   * accent decorations, etc. `null` (default) means "no skin, use the
   * raw theme settings only". See `BUILTIN_SKINS` below.
   */
  activeSkinId?: string | null
  /**
   * Raw CSS injected globally by the active skin. Stored on the settings
   * object so the skin's visual rules persist across reloads / re-syncs
   * without a hardcoded lookup. Set by `applySkin`, cleared by
   * `clearSkin`. Do NOT edit by hand.
   */
  customSkinCss?: string
  /**
   * Snapshot of the skin-affected keys captured the moment a skin was
   * applied, so `clearSkin` can restore them faithfully even after a
   * page reload or fresh device sync. Set by `applySkin`, consumed and
   * cleared by `clearSkin`. Do NOT edit by hand.
   */
  _preSkinSnapshot?: Partial<VisualThemeSettings>
}

/**
 * CSS font stacks for each `fontFamily` option. Update both this map and
 * `applySettings` if you add a new option.
 */
export const FONT_STACKS: Record<NonNullable<VisualThemeSettings['fontFamily']>, string> = {
  system: `'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`,
  pixel: `'NoRe Sans Pixel Pro', 'Figtree', monospace`,
}

/**
 * A "skin" is a bundle of theme settings + global CSS rules that goes
 * beyond simple colour switching. It can flip the font, push specific
 * `--var` overrides, force-disable blur, and inject arbitrary CSS to
 * change borders, corners, decorative overlays, etc.
 *
 * Skins are layered ON TOP of the base custom-theme system, so users
 * can still tweak colours afterwards. Picking a different skin (or
 * "None") cleanly clears the previous skin's contribution.
 */
export interface Skin {
  id: string
  name: string
  description: string
  /** True for skins that aren't yet polished - shows a "Beta" badge. */
  isBeta?: boolean
  /** Path to a preview image (relative to /public). */
  preview?: string
  /** Theme settings merged into `VisualThemeSettings` when the skin is applied. */
  themeOverrides: Partial<VisualThemeSettings>
  /**
   * Raw global CSS rules that get injected into a `<style id="harmony-skin-styles">`
   * element on apply, cleared on `clearSkin`. Use for non-variable rules
   * the skin needs - sharp corners, scanline overlays, decorative
   * pseudo-elements, etc.
   */
  globalCss?: string
}

export const BUILTIN_SKINS: Skin[] = [
  {
    id: 'sdr-001',
    name: 'SDR-001 / Neo Kobe 1988',
    description:
      'A noir-cyberpunk skin: blood-red accents, pure-black panels, pixel typography, sharp corners. ' +
      'Inspired by 80s/90s detective UIs. Forces blur off and switches the font to NoRe Sans Pixel.',
    isBeta: true,
    preview: '/assets/skins/sdr-001-preview.png',
    themeOverrides: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#DC143C',
      customAccentColor: '#DC143C',
      customBackgroundColor: '#DC143C',
      customBackgroundLightness: 5,
      customBackgroundChroma: -6,
      customCssOverrides: {
        '--harmony-primary': '#DC143C',
        '--harmony-primary-hover': '#FF3355',
        '--harmony-accent': '#DC143C',
        '--text-primary': '#EDEDF2',
        '--text-secondary': '#A8A8B6',
        '--text-muted': '#7A7A8A',
        '--border-primary': 'rgba(220, 20, 60, 0.35)',
        '--border-secondary': 'rgba(220, 20, 60, 0.18)',
        '--border-focus': '#DC143C',
        '--border-hover': '#DC143C',
        '--shadow-small': '0 0 0 1px rgba(220, 20, 60, 0.2)',
        '--shadow-medium': '0 0 12px rgba(220, 20, 60, 0.18)',
        '--shadow-large': '0 0 24px rgba(220, 20, 60, 0.25)',
      },
      fontFamily: 'pixel',
      // NOTE: deliberately NOT setting `disableGlassBlur` here. The skin's
      // CSS forces `backdrop-filter: none` under its own data-attribute
      // scope, so the user's blur preference is preserved when they
      // switch back to "None".
    },
    globalCss: `
/* ============================================================================
   SDR-001 / NEO KOBE 1988
   --------------------------------------------------------------------------
   Cyberpunk-noir skin. Visible CRT scanlines, terminal-prefix sidebar,
   bracketed category headers, sharp corners, fixed HUD badge, red focus
   rings, custom scrollbar, crosshair cursor on the chat surface. Scoped
   under [data-skin="sdr-001"] on :root.
   ========================================================================== */

[data-skin="sdr-001"] {
  --harmony-radius-sm: 0px;
  --harmony-radius-md: 2px;
  --harmony-radius-lg: 2px;
  color-scheme: dark;
}

/* Body backdrop: a slightly-purple slate (legible, not pitch black). The
   vignette is very soft and only kicks in past 80% of viewport so the
   chat area itself never goes dim. */
[data-skin="sdr-001"] body {
  background-color: #1c1c28 !important;
  background-image:
    radial-gradient(
      ellipse at center,
      transparent 80%,
      rgba(0, 0, 0, 0.18) 100%
    );
  background-attachment: fixed;
}

/* CRT scanline overlay - black-only, multiplied. Rides above every
   other paint pass. Pointer events off so it's purely cosmetic. */
[data-skin="sdr-001"] body::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 9999;
  background: repeating-linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0.16) 0px,
    rgba(0, 0, 0, 0.16) 1px,
    transparent 1px,
    transparent 2px
  );
  mix-blend-mode: multiply;
}

/* A 1px hairline red border around the entire viewport. Replaces the
   over-strong red phosphor glow that was washing out the UI. */
[data-skin="sdr-001"] body::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 9998;
  border: 1px solid rgba(220, 20, 60, 0.45);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.4);
}

/* Fixed HUD badge - tiny terminal-style identifier in the bottom-left
   corner, like "rom version" footers in retrofuturistic UIs.  */
[data-skin="sdr-001"] .app-container::before,
[data-skin="sdr-001"] #app::before {
  content: 'SDR-001 // NEO KOBE 1988';
  position: fixed;
  bottom: 6px;
  left: 8px;
  z-index: 9997;
  pointer-events: none;
  font-family: 'NoRe Sans Pixel Pro', monospace;
  font-size: 10px;
  letter-spacing: 0.12em;
  color: rgba(220, 20, 60, 0.85);
  text-shadow: 0 0 6px rgba(220, 20, 60, 0.5);
  padding: 2px 6px;
  border: 1px solid rgba(220, 20, 60, 0.55);
  background: rgba(0, 0, 0, 0.6);
}

/* Sharp corners across the visible surfaces. We DON'T target the universal
   selector so emoji chips, avatars, and circular controls stay round. */
[data-skin="sdr-001"] .modal-container,
[data-skin="sdr-001"] .modal-content,
[data-skin="sdr-001"] .settings-section,
[data-skin="sdr-001"] .form-input,
[data-skin="sdr-001"] .btn,
[data-skin="sdr-001"] .card,
[data-skin="sdr-001"] .message-input-wrapper,
[data-skin="sdr-001"] .channel-item,
[data-skin="sdr-001"] .nav-item,
[data-skin="sdr-001"] .public-servers-modal,
[data-skin="sdr-001"] .create-server-modal,
[data-skin="sdr-001"] .voice-dock,
[data-skin="sdr-001"] .voice-dock-container,
[data-skin="sdr-001"] .voice-overlay,
[data-skin="sdr-001"] .context-menu,
[data-skin="sdr-001"] .action-dropdown,
[data-skin="sdr-001"] .notification-dropdown,
[data-skin="sdr-001"] .toast,
[data-skin="sdr-001"] .reaction,
[data-skin="sdr-001"] .message-actions,
[data-skin="sdr-001"] .channel-list-item {
  border-radius: 2px !important;
}

/* Hairline red separators. */
[data-skin="sdr-001"] hr,
[data-skin="sdr-001"] .divider {
  border: 0;
  height: 1px;
  background: linear-gradient(
    to right,
    transparent,
    rgba(220, 20, 60, 0.55),
    transparent
  );
}

/* Inputs - red focus ring + subtle inner glow. */
[data-skin="sdr-001"] input:focus,
[data-skin="sdr-001"] textarea:focus,
[data-skin="sdr-001"] select:focus,
[data-skin="sdr-001"] [contenteditable="true"]:focus {
  outline: 1px solid #DC143C !important;
  outline-offset: -1px;
  box-shadow:
    0 0 0 2px rgba(220, 20, 60, 0.22),
    inset 0 0 16px rgba(220, 20, 60, 0.08) !important;
}

/* Section / header text - HUD label feel. */
[data-skin="sdr-001"] .section-title,
[data-skin="sdr-001"] .settings-title,
[data-skin="sdr-001"] .modal-title,
[data-skin="sdr-001"] .nav-section-title,
[data-skin="sdr-001"] .channel-category-name,
[data-skin="sdr-001"] .server-name {
  letter-spacing: 0.08em !important;
  text-transform: uppercase !important;
  text-shadow: 0 0 8px rgba(220, 20, 60, 0.35);
}

/* Primary buttons - red glow + uppercase + tracked-out spacing. */
[data-skin="sdr-001"] .btn-primary {
  letter-spacing: 0.06em;
  text-transform: uppercase;
  box-shadow:
    0 0 0 1px rgba(220, 20, 60, 0.55),
    0 0 12px rgba(220, 20, 60, 0.25),
    inset 0 0 12px rgba(220, 20, 60, 0.12);
}

[data-skin="sdr-001"] .btn-primary:hover:not(:disabled) {
  box-shadow:
    0 0 0 1px rgba(220, 20, 60, 0.85),
    0 0 18px rgba(220, 20, 60, 0.45),
    inset 0 0 16px rgba(220, 20, 60, 0.2);
}

/* Hover/focus glow on every interactive surface that already had a
   regular hover state - we keep their existing background and just stack
   a red shadow on top so the highlight reads as "something powered up." */
[data-skin="sdr-001"] .btn:hover,
[data-skin="sdr-001"] .nav-item:hover,
[data-skin="sdr-001"] .channel-item:hover,
[data-skin="sdr-001"] .message-item:hover {
  box-shadow: 0 0 14px rgba(220, 20, 60, 0.18);
}

/* Selection color - red highlight for that "scanning a database" vibe. */
[data-skin="sdr-001"] ::selection {
  background: rgba(220, 20, 60, 0.55);
  color: #fff;
  text-shadow: none;
}

/* Custom scrollbar in red (Webkit + Firefox). */
[data-skin="sdr-001"] ::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
[data-skin="sdr-001"] ::-webkit-scrollbar-track {
  background: rgba(220, 20, 60, 0.04);
}
[data-skin="sdr-001"] ::-webkit-scrollbar-thumb {
  background: rgba(220, 20, 60, 0.45);
  border-radius: 0;
  box-shadow: 0 0 6px rgba(220, 20, 60, 0.4);
}
[data-skin="sdr-001"] ::-webkit-scrollbar-thumb:hover {
  background: rgba(220, 20, 60, 0.85);
}
[data-skin="sdr-001"] {
  scrollbar-color: rgba(220, 20, 60, 0.45) rgba(220, 20, 60, 0.04);
}

/* Crosshair cursor on the chat surface for that detective-grid feel.
   Limited to the message list to avoid hijacking text input + buttons. */
[data-skin="sdr-001"] .message-display,
[data-skin="sdr-001"] [data-chat-messages] {
  cursor: crosshair;
}

/* Server / channel sidebar gets a 1px red leftmost rule + a faint corner
   bracket on its top-right so it reads like a HUD frame. */
[data-skin="sdr-001"] .channel-sidebar {
  border-right: 1px solid rgba(220, 20, 60, 0.25);
  position: relative;
}
[data-skin="sdr-001"] .channel-sidebar::before,
[data-skin="sdr-001"] .channel-sidebar::after {
  content: '';
  position: absolute;
  width: 14px;
  height: 14px;
  border: 1px solid rgba(220, 20, 60, 0.7);
  pointer-events: none;
}
[data-skin="sdr-001"] .channel-sidebar::before {
  top: 4px;
  right: 4px;
  border-bottom: 0;
  border-left: 0;
}
[data-skin="sdr-001"] .channel-sidebar::after {
  bottom: 4px;
  right: 4px;
  border-top: 0;
  border-left: 0;
}

/* Same corner brackets on every modal container - the modal feels like a
   target reticule popping up. */
[data-skin="sdr-001"] .modal-container {
  position: relative;
}
[data-skin="sdr-001"] .modal-container::before,
[data-skin="sdr-001"] .modal-container::after {
  content: '';
  position: absolute;
  width: 18px;
  height: 18px;
  border: 1px solid rgba(220, 20, 60, 0.85);
  pointer-events: none;
  filter: drop-shadow(0 0 4px rgba(220, 20, 60, 0.4));
}
[data-skin="sdr-001"] .modal-container::before {
  top: -1px;
  left: -1px;
  border-right: 0;
  border-bottom: 0;
}
[data-skin="sdr-001"] .modal-container::after {
  bottom: -1px;
  right: -1px;
  border-left: 0;
  border-top: 0;
}

/* Active / selected channel gets a red leading bar instead of the default
   cyan/teal Discord-style indicator. */
[data-skin="sdr-001"] .channel-item.active,
[data-skin="sdr-001"] .channel-item.selected,
[data-skin="sdr-001"] .nav-item.active {
  background: rgba(220, 20, 60, 0.12) !important;
  box-shadow: inset 3px 0 0 #DC143C;
}

/* ----------------------------------------------------------------------------
   STRUCTURAL DEPARTURES
   The CSS below is what makes the skin stop looking "Harmony with a red
   accent" and start looking like a different application.
   -------------------------------------------------------------------------- */

/* Channel list items: each row gets a terminal-style ">" prefix + tracked
   spacing. Adds presence without changing the underlying markup. */
[data-skin="sdr-001"] .channel-item .channel-name::before,
[data-skin="sdr-001"] .channel-list-item .channel-name::before,
[data-skin="sdr-001"] .nav-item > span::before {
  content: '> ';
  color: rgba(220, 20, 60, 0.7);
  font-family: 'NoRe Sans Pixel Pro', monospace;
  margin-right: 4px;
}
[data-skin="sdr-001"] .channel-name,
[data-skin="sdr-001"] .nav-item > span {
  letter-spacing: 0.04em;
}

/* Category headers get HUD-style brackets + uppercase. */
[data-skin="sdr-001"] .channel-category-name::before,
[data-skin="sdr-001"] .nav-section-title::before {
  content: '[ ';
  color: rgba(220, 20, 60, 0.85);
}
[data-skin="sdr-001"] .channel-category-name::after,
[data-skin="sdr-001"] .nav-section-title::after {
  content: ' ]';
  color: rgba(220, 20, 60, 0.85);
}
[data-skin="sdr-001"] .channel-category-name,
[data-skin="sdr-001"] .nav-section-title {
  letter-spacing: 0.12em !important;
  font-size: 11px !important;
}

/* Message rows feel like log entries: hairline red bottom rule, monospace
   timestamps with a faint red glow, message gutter switched to a column
   of dots. */
[data-skin="sdr-001"] .message-item {
  border-bottom: 1px solid rgba(220, 20, 60, 0.06);
  padding-bottom: 4px;
}
[data-skin="sdr-001"] .message-item .timestamp,
[data-skin="sdr-001"] .timestamp,
[data-skin="sdr-001"] .system-timestamp,
[data-skin="sdr-001"] .message-content-only .message-gutter::before {
  font-family: 'NoRe Sans Pixel Pro', monospace !important;
  letter-spacing: 0.05em;
  color: rgba(220, 20, 60, 0.6) !important;
}

/* Username text gets uppercase + tracked-out spacing for that bridge-crew
   roll-call feel. */
[data-skin="sdr-001"] .message-meta .username,
[data-skin="sdr-001"] .username-text {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 700;
}

/* Avatars: hard 2px red border + a faint red drop-shadow halo. Combined
   with the existing circular shape this reads as "subject ID badge". */
[data-skin="sdr-001"] .avatar,
[data-skin="sdr-001"] .user-avatar,
[data-skin="sdr-001"] .message-avatar img {
  border: 2px solid rgba(220, 20, 60, 0.55) !important;
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.6),
    0 0 8px rgba(220, 20, 60, 0.35);
}

/* Chat input area gets a heavier "command line" affordance: a flashing
   red caret accent on the wrapper, and a subtle red top rule that reads
   as a separator between the message log and the input. */
[data-skin="sdr-001"] .message-input-wrapper,
[data-skin="sdr-001"] .rich-text-editor {
  border: 1px solid rgba(220, 20, 60, 0.4) !important;
  background: rgba(0, 0, 0, 0.35) !important;
  box-shadow: inset 0 0 32px rgba(220, 20, 60, 0.05);
}

/* Server sidebar: drop the default backdrop, push a darker pure-black
   panel + a top-to-bottom fade so it reads like a console rail. */
[data-skin="sdr-001"] .server-sidebar,
[data-skin="sdr-001"] .servers-sidebar {
  background: linear-gradient(to bottom, #0c0c12, #08080d) !important;
  border-right: 1px solid rgba(220, 20, 60, 0.25);
}

/* Server icons: kill the rounded squircle in favour of a sharp 2px
   square with a red glow on hover. Avatars inside servers stay round
   so users still recognize themselves. */
[data-skin="sdr-001"] .server-icon,
[data-skin="sdr-001"] .servers-list .server-item img {
  border-radius: 2px !important;
  filter: contrast(1.05) saturate(0.85);
}
[data-skin="sdr-001"] .servers-list .server-item:hover img {
  box-shadow: 0 0 14px rgba(220, 20, 60, 0.55);
}

/* Reaction chips read as command tags. */
[data-skin="sdr-001"] .reaction {
  border: 1px solid rgba(220, 20, 60, 0.4) !important;
  background: rgba(220, 20, 60, 0.06) !important;
}
[data-skin="sdr-001"] .reaction.reacted {
  background: rgba(220, 20, 60, 0.18) !important;
  box-shadow: 0 0 8px rgba(220, 20, 60, 0.3);
}

/* Emoji and decorative inline images on dark surfaces feel less Discord
   when slightly desaturated and contrast-bumped. */
[data-skin="sdr-001"] .emoji-image,
[data-skin="sdr-001"] .twemoji {
  filter: contrast(1.1) saturate(0.92);
}

/* Voice dock: monitor bar, not a glass pill. */
[data-skin="sdr-001"] .voice-dock,
[data-skin="sdr-001"] .voice-dock-container {
  background: linear-gradient(180deg, #0d0d14, #06060a) !important;
  border: 1px solid rgba(220, 20, 60, 0.45) !important;
  box-shadow:
    inset 0 0 24px rgba(220, 20, 60, 0.06),
    0 0 16px rgba(220, 20, 60, 0.18);
}

/* Tooltips get the same HUD treatment. */
[data-skin="sdr-001"] [role="tooltip"],
[data-skin="sdr-001"] .tooltip {
  background: #06060a !important;
  border: 1px solid rgba(220, 20, 60, 0.55) !important;
  font-family: 'NoRe Sans Pixel Pro', monospace !important;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  font-size: 11px !important;
}

/* Code blocks: green-on-black 80s monitor look. Different green from the
   normal dark theme to make it clear this is the SDR-001 console feel. */
[data-skin="sdr-001"] pre,
[data-skin="sdr-001"] code,
[data-skin="sdr-001"] .code-block {
  background: #04040a !important;
  border: 1px solid rgba(220, 20, 60, 0.35) !important;
  color: #2bff7a !important;
}
[data-skin="sdr-001"] pre *,
[data-skin="sdr-001"] code *,
[data-skin="sdr-001"] .code-block * {
  color: inherit !important;
}

/* ----------------------------------------------------------------------------
   LAYOUT DEPARTURES
   These rules change density / sizing / position to push the skin past
   "default Harmony with a red theme" and into "this is a different
   application." All purely CSS (no markup changes) and scoped under the
   data-skin attribute, so picking "None" cleans them up automatically.
   -------------------------------------------------------------------------- */

/* Server sidebar (left rail) gets significantly narrower with sharp
   2px-square icons and tighter spacing. The thumbnails feel like
   subject-ID stamps in a database column rather than Discord guild pills. */
[data-skin="sdr-001"] .servers-sidebar,
[data-skin="sdr-001"] .server-sidebar,
[data-skin="sdr-001"] .ServerSidebar {
  width: 56px !important;
  padding: 8px 0 !important;
  gap: 6px !important;
}
[data-skin="sdr-001"] .servers-sidebar .server-item,
[data-skin="sdr-001"] .server-sidebar .server-item {
  width: 40px !important;
  height: 40px !important;
  border-radius: 2px !important;
}

/* Channel sidebar (the column with text channels / voice channels) gets
   a subtle leading rule, denser line-heights, and a bracketed section
   header treatment. */
[data-skin="sdr-001"] .channel-sidebar,
[data-skin="sdr-001"] .ChannelSidebar {
  background: linear-gradient(180deg, #14141c, #0e0e16) !important;
  border-right: 1px solid rgba(220, 20, 60, 0.22);
}
[data-skin="sdr-001"] .channel-item,
[data-skin="sdr-001"] .channel-list-item,
[data-skin="sdr-001"] .nav-item {
  padding: 5px 10px !important;
  border-radius: 0 !important;
  border-bottom: 1px dashed rgba(220, 20, 60, 0.06);
}

/* Chat header (top of chat) - read it as a HUD console title bar, with
   uppercase tracked-out channel names and a fake STATUS row on the right
   via a pseudo-element. */
[data-skin="sdr-001"] .chat-header,
[data-skin="sdr-001"] .ChatHeader {
  background: linear-gradient(180deg, #14141c, #0e0e16) !important;
  border-bottom: 1px solid rgba(220, 20, 60, 0.35);
  position: relative;
}
[data-skin="sdr-001"] .chat-header::after {
  content: 'TX/RX READY ¦ NEO KOBE GRID 02';
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  font-family: 'NoRe Sans Pixel Pro', monospace;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: rgba(220, 20, 60, 0.65);
  text-shadow: 0 0 6px rgba(220, 20, 60, 0.35);
  pointer-events: none;
}

/* Chat input area - command-line affordance via a ">>>" pseudo-prefix. */
[data-skin="sdr-001"] .message-input-wrapper {
  position: relative;
  padding-left: 44px !important;
}
[data-skin="sdr-001"] .message-input-wrapper::before {
  content: '>>>';
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  font-family: 'NoRe Sans Pixel Pro', monospace;
  font-size: 14px;
  letter-spacing: 0.08em;
  color: rgba(220, 20, 60, 0.85);
  text-shadow: 0 0 6px rgba(220, 20, 60, 0.45);
  pointer-events: none;
}

/* Member list (right column) - swap the pill-style entries for a flat
   text list with status-prefix glyphs. Online/offline/dnd headers get
   the bracket treatment too. */
[data-skin="sdr-001"] .member-list-item,
[data-skin="sdr-001"] .user-list-item {
  background: transparent !important;
  border-radius: 0 !important;
  padding: 4px 10px !important;
  border-bottom: 1px dashed rgba(220, 20, 60, 0.05);
}
[data-skin="sdr-001"] .member-list-item .member-name::before,
[data-skin="sdr-001"] .user-list-item .user-name::before {
  content: '● ';
  color: rgba(46, 204, 113, 0.85);
  margin-right: 4px;
  font-family: 'NoRe Sans Pixel Pro', monospace;
}
[data-skin="sdr-001"] .member-list-item.offline .member-name::before,
[data-skin="sdr-001"] .user-list-item.offline .user-name::before {
  content: '○ ';
  color: rgba(180, 180, 180, 0.5);
}

/* Member list section headers - bracket + uppercase like channel
   categories. */
[data-skin="sdr-001"] .member-section-header,
[data-skin="sdr-001"] .user-list-section-header,
[data-skin="sdr-001"] .role-group-name {
  letter-spacing: 0.14em !important;
  text-transform: uppercase !important;
  font-size: 10px !important;
  color: rgba(220, 20, 60, 0.85) !important;
}
[data-skin="sdr-001"] .member-section-header::before,
[data-skin="sdr-001"] .user-list-section-header::before,
[data-skin="sdr-001"] .role-group-name::before {
  content: '── ';
  letter-spacing: 0;
}
[data-skin="sdr-001"] .member-section-header::after,
[data-skin="sdr-001"] .user-list-section-header::after,
[data-skin="sdr-001"] .role-group-name::after {
  content: ' ──';
  letter-spacing: 0;
}

/* Notification badges - sharp red squares, pixel font. */
[data-skin="sdr-001"] .badge,
[data-skin="sdr-001"] .notification-badge,
[data-skin="sdr-001"] .unread-count {
  background: #DC143C !important;
  color: #fff !important;
  border-radius: 0 !important;
  font-family: 'NoRe Sans Pixel Pro', monospace !important;
  letter-spacing: 0.06em !important;
  box-shadow: 0 0 8px rgba(220, 20, 60, 0.45);
  min-width: 16px !important;
  height: 16px !important;
  font-size: 10px !important;
  line-height: 16px !important;
}

/* Settings sidebar (when in user/server settings) gets the same
   monospaced bracket treatment. */
[data-skin="sdr-001"] .settings-sidebar,
[data-skin="sdr-001"] .settings-nav {
  background: linear-gradient(180deg, #14141c, #0e0e16) !important;
  border-right: 1px solid rgba(220, 20, 60, 0.22);
}
[data-skin="sdr-001"] .settings-nav .nav-item {
  padding: 6px 12px !important;
}

/* Container corner brackets - applied to the chat area + member list +
   channel sidebar + server sidebar so every "panel" reads as a HUD
   compartment, not a flat Discord column. We use ::before/::after pairs
   on each, but to keep z-index clean we use outline + clip-path-free
   markers via box-shadow on small fixed boxes. */
[data-skin="sdr-001"] .chat-component,
[data-skin="sdr-001"] .ChatComponent,
[data-skin="sdr-001"] .member-list,
[data-skin="sdr-001"] .UserList {
  position: relative;
  border: 1px solid rgba(220, 20, 60, 0.18);
}
[data-skin="sdr-001"] .chat-component::before,
[data-skin="sdr-001"] .ChatComponent::before,
[data-skin="sdr-001"] .member-list::before,
[data-skin="sdr-001"] .UserList::before {
  content: '';
  position: absolute;
  top: -1px;
  left: -1px;
  width: 12px;
  height: 12px;
  border-top: 2px solid rgba(220, 20, 60, 0.85);
  border-left: 2px solid rgba(220, 20, 60, 0.85);
  pointer-events: none;
}
[data-skin="sdr-001"] .chat-component::after,
[data-skin="sdr-001"] .ChatComponent::after,
[data-skin="sdr-001"] .member-list::after,
[data-skin="sdr-001"] .UserList::after {
  content: '';
  position: absolute;
  bottom: -1px;
  right: -1px;
  width: 12px;
  height: 12px;
  border-bottom: 2px solid rgba(220, 20, 60, 0.85);
  border-right: 2px solid rgba(220, 20, 60, 0.85);
  pointer-events: none;
}

/* Density bumps - a tiny bit more breathing room in dense lists feels
   distinct from Discord's tight rhythm. */
[data-skin="sdr-001"] .message-item {
  padding-top: 6px !important;
}
[data-skin="sdr-001"] .message-meta {
  margin-bottom: 2px;
}

/* Replace softness with deliberate sharpness on every shadow. */
[data-skin="sdr-001"] {
  --shadow-modal: 0 0 0 1px rgba(220, 20, 60, 0.55), 0 0 32px rgba(220, 20, 60, 0.2);
}

/* Force-disable blur in case someone disabled the user-level toggle but
   the skin is still on. The skin requires sharpness to read right. */
[data-skin="sdr-001"] *,
[data-skin="sdr-001"] {
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

/* Subtle red-glow flicker on the brand mark / app shell. Honours
   prefers-reduced-motion + the in-app reduceMotion attribute. */
@keyframes harmony-sdr-flicker {
  0%, 92%, 100% { opacity: 1; }
  93%           { opacity: 0.85; }
  94%           { opacity: 1; }
  96%           { opacity: 0.92; }
  97%           { opacity: 1; }
}
[data-skin="sdr-001"]:not([data-reduce-motion="true"]) .server-icon,
[data-skin="sdr-001"]:not([data-reduce-motion="true"]) .app-logo,
[data-skin="sdr-001"]:not([data-reduce-motion="true"]) .auth-logo {
  animation: harmony-sdr-flicker 8s infinite ease-in-out;
}
@media (prefers-reduced-motion: reduce) {
  [data-skin="sdr-001"] .server-icon,
  [data-skin="sdr-001"] .app-logo,
  [data-skin="sdr-001"] .auth-logo {
    animation: none;
  }
}
`.trim(),
  },
]

export interface ThemePreset {
  name: string
  description: string
  settings: Partial<VisualThemeSettings>
}

export interface SavedCustomTheme {
  id: string
  name: string
  settings: Partial<VisualThemeSettings>
  createdAt: string
}

const SAVED_THEMES_KEY = 'custom-themes'

export const COMMUNITY_PRESETS: ThemePreset[] = [
  {
    name: 'Harmony Teal',
    description: 'The signature Harmony look - fresh, modern, and inviting',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#0EA5E9',
      customAccentColor: '#0EA5E9',
      customBackgroundColor: '#0EA5E9',
      customBackgroundLightness: 20,
      customBackgroundChroma: 2,
      customCssOverrides: {
        '--harmony-primary': '#0EA5E9',
        '--harmony-primary-hover': '#0284C7',
        '--harmony-accent': '#38BDF8',
      }
    }
  },
  {
    name: 'Emerald',
    description: 'Growth, balance, and natural harmony',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#10B981',
      customAccentColor: '#10B981',
      customBackgroundColor: '#10B981',
      customBackgroundLightness: 20,
      customBackgroundChroma: 2,
      customCssOverrides: {
        '--harmony-primary': '#10B981',
        '--harmony-primary-hover': '#059669',
        '--harmony-accent': '#34D399',
      }
    }
  },
  {
    name: 'Coral',
    description: 'Warm, energetic, and community-driven',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#F97316',
      customAccentColor: '#F97316',
      customBackgroundColor: '#F97316',
      customBackgroundLightness: 20,
      customBackgroundChroma: 1,
      customCssOverrides: {
        '--harmony-primary': '#F97316',
        '--harmony-primary-hover': '#EA580C',
        '--harmony-accent': '#FB923C',
      }
    }
  },
  {
    name: 'Violet',
    description: 'Creative and distinctive with deep purple tones',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#8B5CF6',
      customAccentColor: '#8B5CF6',
      customBackgroundColor: '#8B5CF6',
      customBackgroundLightness: 20,
      customBackgroundChroma: 2,
      customCssOverrides: {
        '--harmony-primary': '#8B5CF6',
        '--harmony-primary-hover': '#7C3AED',
        '--harmony-accent': '#A78BFA',
      }
    }
  },
  {
    name: 'Rose',
    description: 'Bold, warm, and community-focused',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#F43F5E',
      customAccentColor: '#F43F5E',
      customBackgroundColor: '#F43F5E',
      customBackgroundLightness: 20,
      customBackgroundChroma: 2,
      customCssOverrides: {
        '--harmony-primary': '#F43F5E',
        '--harmony-primary-hover': '#E11D48',
        '--harmony-accent': '#FB7185',
      }
    }
  },
  {
    name: 'Ocean Blue',
    description: 'A deep ocean blue theme with cool tones',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#1258fa',
      customAccentColor: '#1258fa',
      customBackgroundColor: '#1258fa',
      customBackgroundLightness: 25,
      customBackgroundChroma: 3,
      customCssOverrides: {
        '--harmony-primary': '#1258fa',
        '--harmony-primary-hover': '#0e47d4',
        '--harmony-accent': '#4ecdc4',
      }
    }
  },
  {
    name: 'Sakura',
    description: 'Cherry blossom inspired pink theme',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#e91e8c',
      customAccentColor: '#e91e8c',
      customBackgroundColor: '#e91e8c',
      customBackgroundLightness: 20,
      customBackgroundChroma: 2,
    }
  },
  {
    name: 'Forest',
    description: 'Natural green forest tones',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#2d9b4e',
      customAccentColor: '#2d9b4e',
      customBackgroundColor: '#2d9b4e',
      customBackgroundLightness: 20,
      customBackgroundChroma: 2,
    }
  },
  {
    name: 'Amber',
    description: 'Warm amber and gold tones',
    settings: {
      theme: 'custom',
      customThemeMode: 'dark',
      customPrimaryColor: '#f59e0b',
      customAccentColor: '#f59e0b',
      customBackgroundColor: '#f59e0b',
      customBackgroundLightness: 20,
      customBackgroundChroma: 1,
    }
  }
]

// Preset theme color mappings
const PRESET_THEMES = {
  dark: {
    primary: '#0EA5E9',
    bgChat: '#313338',
    bgSidebar: '#292b2f',
    textPrimary: '#f2f3f5',
    textSecondary: '#b5bac1',
    borderPrimary: 'rgba(255, 255, 255, 0.08)',
    isLightTheme: false,
    secondary: '#38BDF8',
    accent: '#ff7675',
  },
  light: {
    primary: '#0EA5E9',
    bgChat: '#ffffff',
    bgSidebar: '#f2f3f5',
    textPrimary: '#2e3338',
    textSecondary: '#4e5058',
    borderPrimary: 'rgba(0, 0, 0, 0.12)',
    isLightTheme: true,
    secondary: '#38BDF8',
    accent: '#ff7675',
  },
  midnight: {
    primary: '#0EA5E9',
    bgChat: '#1e2124',
    bgSidebar: '#1a1d20',
    textPrimary: '#f2f3f5',
    textSecondary: '#b5bac1',
    borderPrimary: 'rgba(255, 255, 255, 0.08)',
    isLightTheme: false,
    secondary: '#38BDF8',
    accent: '#ff7675',
  },
}

// Global state (singleton pattern)
const settings = ref<VisualThemeSettings>({
  theme: 'dark',
  customThemeMode: 'dark',
  customPrimaryColor: '#0EA5E9',
  customAccentColor: '#0EA5E9',
  customBackgroundColor: '#0EA5E9',
  customBackgroundLightness: 0,
  customBackgroundChroma: 0,
  fontSize: 14,
  zoomLevel: 100,
  showTimestamps: true,
  use24HourTime: false,
  compactMode: false,
  highContrast: false,
  reduceMotion: false,
  screenReaderSupport: false,
  showCustomEmojisInDisplayNames: true,
  greentextEnabled: true,
  fontFamily: 'system',
  disableGlassBlur: false,
  activeSkinId: null,
  customSkinCss: '',
})

const isInitialized = ref(false)
const isSaving = ref(false)

let saveTimeout: ReturnType<typeof setTimeout> | null = null

/**
 * Apply preset theme styles
 */
function applyPresetTheme(themeName: 'dark' | 'light' | 'midnight') {
  const root = document.documentElement
  const theme = PRESET_THEMES[themeName]
  
  // Primary colors
  root.style.setProperty('--harmony-primary', theme.primary)
  root.style.setProperty('--harmony-primary-hover', '#0284C7')
  root.style.setProperty('--harmony-primary-light', 'rgba(14, 165, 233, 0.1)')
  root.style.setProperty('--harmony-primary-alpha', 'rgba(14, 165, 233, 0.15)')
  root.style.setProperty('--harmony-primary-alpha-light', 'rgba(14, 165, 233, 0.1)')
  root.style.setProperty('--harmony-primary-alpha-strong', 'rgba(14, 165, 233, 0.25)')
  root.style.setProperty('--harmony-secondary', theme.secondary)
  root.style.setProperty('--harmony-secondary-hover', '#0284C7')
  root.style.setProperty('--harmony-secondary-light', 'rgba(14, 165, 233, 0.1)')
  root.style.setProperty('--harmony-secondary-alpha', 'rgba(14, 165, 233, 0.15)')
  root.style.setProperty('--harmony-secondary-alpha-light', 'rgba(14, 165, 233, 0.1)')
  root.style.setProperty('--harmony-secondary-alpha-strong', 'rgba(14, 165, 233, 0.25)')
  root.style.setProperty('--harmony-accent', theme.accent)
  root.style.setProperty('--harmony-accent-hover', '#0284C7')
  root.style.setProperty('--harmony-accent-light', 'rgba(14, 165, 233, 0.1)')
  root.style.setProperty('--harmony-accent-alpha', 'rgba(14, 165, 233, 0.15)')
  root.style.setProperty('--harmony-accent-alpha-light', 'rgba(14, 165, 233, 0.1)')
  root.style.setProperty('--harmony-accent-alpha-strong', 'rgba(14, 165, 233, 0.25)')
  root.style.setProperty('--h-primary', theme.primary)
  root.style.setProperty('--h-primary-light', '#38BDF8')
  root.style.setProperty('--h-primary-dark', '#0369A1')
  root.style.setProperty('--h-brand', theme.primary)
  
  // Background colors - use proper defaults based on theme
  if (themeName === 'dark') {
    root.style.setProperty('--h-chat', '#313338')
    root.style.setProperty('--h-chat-light', '#383a40')
    root.style.setProperty('--h-chat-lighter', '#40444b')
    root.style.setProperty('--h-chat-dark', '#141618')
    root.style.setProperty('--h-chat-darker', '#0c0d0e')
    root.style.setProperty('--h-chat-alpha', 'rgba(49, 51, 56, 0.67)')
    root.style.setProperty('--h-chat-alpha-light', 'rgba(49, 51, 56, 0.5)')
    
    root.style.setProperty('--h-sidebar', '#2b2d31')
    root.style.setProperty('--h-sidebar-light', '#35373c')
    root.style.setProperty('--h-sidebar-alpha', 'rgba(43, 45, 49, 0.67)')
    
    root.style.setProperty('--h-black', '#1e1f22')
    root.style.setProperty('--h-black-light', '#313336')
    root.style.setProperty('--h-black-lighter', '#40444b')
    root.style.setProperty('--h-black-darker', '#000000')
    root.style.setProperty('--h-black-alpha', 'rgba(30, 31, 34, 0.67)')
    
    // Original background system colors
    root.style.setProperty('--background-primary', '#1a1a1e')
    root.style.setProperty('--background-secondary', '#17181a')
    root.style.setProperty('--background-tertiary', '#121214')
    root.style.setProperty('--background-quaternary', '#222327')
    root.style.setProperty('--background-quinary', '#202024')
    // Alpha variants
    root.style.setProperty('--background-primary-alpha', '#1a1a1eaa')
    root.style.setProperty('--background-secondary-alpha', '#17181aaa')
    root.style.setProperty('--background-tertiary-alpha', '#121214aa')
    root.style.setProperty('--background-senary', '#0a0b0d')
    root.style.setProperty('--background-senary-alpha', '#0a0b0dc7')
  } else if (themeName === 'light') {
    root.style.setProperty('--h-chat', '#ffffff')
    root.style.setProperty('--h-chat-light', '#f6f6f7')
    root.style.setProperty('--h-chat-lighter', '#f2f3f5')
    root.style.setProperty('--h-chat-dark', '#e3e5e8')
    root.style.setProperty('--h-chat-darker', '#d0d2d5')
    root.style.setProperty('--h-chat-alpha', 'rgba(255, 255, 255, 0.85)')
    root.style.setProperty('--h-chat-alpha-light', 'rgba(255, 255, 255, 0.7)')
    
    root.style.setProperty('--h-sidebar', '#f2f3f5')
    root.style.setProperty('--h-sidebar-light', '#e3e5e8')
    root.style.setProperty('--h-sidebar-alpha', 'rgba(242, 243, 245, 0.85)')
    
    root.style.setProperty('--h-black', '#e3e5e8')
    root.style.setProperty('--h-black-light', '#ebedef')
    root.style.setProperty('--h-black-lighter', '#f2f3f5')
    root.style.setProperty('--h-black-darker', '#d0d2d5')
    root.style.setProperty('--h-black-alpha', 'rgba(227, 229, 232, 0.85)')
    
    root.style.setProperty('--background-primary', '#ffffff')
    root.style.setProperty('--background-secondary', '#f6f6f7')
    root.style.setProperty('--background-tertiary', '#f2f3f5')
    root.style.setProperty('--background-quaternary', '#ebedef')
    root.style.setProperty('--background-quinary', '#e3e5e8')
    // Alpha variants (lighter for light theme)
    root.style.setProperty('--background-primary-alpha', 'rgba(255, 255, 255, 0.85)')
    root.style.setProperty('--background-secondary-alpha', 'rgba(246, 246, 247, 0.85)')
    root.style.setProperty('--background-tertiary-alpha', 'rgba(242, 243, 245, 0.85)')
    root.style.setProperty('--background-senary', '#2b2d31')
    root.style.setProperty('--background-senary-alpha', 'rgba(43, 45, 49, 0.78)')
  } else if (themeName === 'midnight') {
    root.style.setProperty('--h-chat', '#1e2124')
    root.style.setProperty('--h-chat-light', '#25272a')
    root.style.setProperty('--h-chat-lighter', '#2b2d31')
    root.style.setProperty('--h-chat-dark', '#18191c')
    root.style.setProperty('--h-chat-darker', '#0f1012')
    root.style.setProperty('--h-chat-alpha', 'rgba(30, 33, 36, 0.67)')
    root.style.setProperty('--h-chat-alpha-light', 'rgba(30, 33, 36, 0.5)')
    
    root.style.setProperty('--h-sidebar', '#1a1d20')
    root.style.setProperty('--h-sidebar-light', '#1f2226')
    root.style.setProperty('--h-sidebar-alpha', 'rgba(26, 29, 32, 0.67)')
    
    root.style.setProperty('--h-black', '#13151a')
    root.style.setProperty('--h-black-light', '#1a1d20')
    root.style.setProperty('--h-black-lighter', '#1f2226')
    root.style.setProperty('--h-black-darker', '#0a0b0d')
    root.style.setProperty('--h-black-alpha', 'rgba(19, 21, 26, 0.67)')
    
    root.style.setProperty('--background-primary', '#1e2124')
    root.style.setProperty('--background-secondary', '#13151a')
    root.style.setProperty('--background-tertiary', '#0f1012')
    root.style.setProperty('--background-quaternary', '#1a1d20')
    root.style.setProperty('--background-quinary', '#13151a')
    // Alpha variants
    root.style.setProperty('--background-primary-alpha', '#1e2124aa')
    root.style.setProperty('--background-secondary-alpha', '#13151aaa')
    root.style.setProperty('--background-tertiary-alpha', '#0f1012aa')
    root.style.setProperty('--background-senary', '#0a0b0d')
    root.style.setProperty('--background-senary-alpha', '#0a0b0dc7')
  }
  
  // Text colors
  root.style.setProperty('--text-primary', theme.textPrimary)
  root.style.setProperty('--text-secondary', theme.textSecondary)
  root.style.setProperty('--text-tertiary', theme.isLightTheme ? '#6e7178' : '#80848e')
  root.style.setProperty('--text-muted', theme.isLightTheme ? '#5e6168' : '#6d6f78')
  
  // Border colors - different alpha values for light vs dark themes
  root.style.setProperty('--border-primary', theme.borderPrimary)
  root.style.setProperty('--border-secondary', theme.isLightTheme ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.06)')
  root.style.setProperty('--border-hover', theme.isLightTheme ? 'rgba(0, 0, 0, 0.15)' : 'rgba(255, 255, 255, 0.12)')
  root.style.setProperty('--border-focus', theme.primary)
  root.style.setProperty('--border-color', theme.isLightTheme ? 'rgba(0, 0, 0, 0.12)' : '#232529')
  
  // Icon colors for light/dark
  root.style.setProperty('--icon-primary', theme.isLightTheme ? '#5e6168' : '#9999a0')
  root.style.setProperty('--icon-secondary', theme.isLightTheme ? '#80838a' : '#66666b')
  root.style.setProperty('--icon-active', theme.isLightTheme ? '#2e3338' : '#fbfbfb')

  // Shadow adjustments for light theme
  root.style.setProperty('--shadow-small', theme.isLightTheme
    ? '0 2px 4px rgba(0, 0, 0, 0.06)' : '0 2px 4px rgba(0, 0, 0, 0.1)')
  root.style.setProperty('--shadow-medium', theme.isLightTheme
    ? '0 4px 8px rgba(0, 0, 0, 0.08)' : '0 4px 8px rgba(0, 0, 0, 0.15)')

  root.setAttribute('data-theme', themeName)
  root.setAttribute('data-theme-type', theme.isLightTheme ? 'light' : 'dark')
  
  debug.log(`🎨 Applied ${themeName} theme`)
}

/**
 * Apply all visual settings to DOM
 */
function applySettings(settings: VisualThemeSettings) {
  const root = document.documentElement
  
  // Apply theme
  if (settings.theme === 'custom' && settings.customAccentColor) {
    try {
      const palette = generateThemePalette(
        settings.customAccentColor,
        settings.customThemeMode,
        settings.customBackgroundColor,
        settings.customBackgroundLightness || 0,
        settings.customPrimaryColor,
        settings.customBackgroundChroma || 0
      )
      applyThemePalette(palette)
    } catch (error) {
      debug.error('Failed to apply custom theme:', error)
      applyPresetTheme('dark')
    }
  } else if (settings.theme !== 'custom') {
    applyPresetTheme(settings.theme)
  }
  
  // Apply CSS variable overrides (runs after theme so overrides take precedence)
  if (settings.customCssOverrides) {
    for (const [varName, value] of Object.entries(settings.customCssOverrides)) {
      if (varName.startsWith('--') && value) {
        root.style.setProperty(varName, value)
      }
    }
  }
  
  // Apply font size
  root.style.setProperty('--message-font-size', `${settings.fontSize}px`)

  // Apply UI font family (the picker in Appearance settings flips this).
  // `--font-family` is consumed by `body` in design-system.css and by the
  // `html, body` rule in App.vue; setting it on `:root` cascades to both.
  const fontKey = settings.fontFamily || 'system'
  const fontStack = FONT_STACKS[fontKey] || FONT_STACKS.system
  root.style.setProperty('--font-family', fontStack)

  // Apply "disable glass blur" preference. The matching global rule lives
  // in design-system.css under `[data-disable-blur="true"]`.
  if (settings.disableGlassBlur) {
    root.setAttribute('data-disable-blur', 'true')
  } else {
    root.removeAttribute('data-disable-blur')
  }

  // Apply active skin id (data attribute used by skin-scoped CSS rules)
  // and inject the skin's global CSS into a dedicated <style> tag so we
  // can swap skins cleanly without leaking rules.
  if (settings.activeSkinId) {
    root.setAttribute('data-skin', settings.activeSkinId)
  } else {
    root.removeAttribute('data-skin')
  }

  if (typeof document !== 'undefined') {
    let skinStyleEl = document.getElementById('harmony-skin-styles') as HTMLStyleElement | null
    if (settings.customSkinCss) {
      if (!skinStyleEl) {
        skinStyleEl = document.createElement('style')
        skinStyleEl.id = 'harmony-skin-styles'
        document.head.appendChild(skinStyleEl)
      }
      if (skinStyleEl.textContent !== settings.customSkinCss) {
        skinStyleEl.textContent = settings.customSkinCss
      }
    } else if (skinStyleEl) {
      skinStyleEl.remove()
    }
  }
  
  // Apply zoom level. `zoom` is a non-standard CSS property not present on
  // `CSSStyleDeclaration` in lib.dom, but every browser we target understands it.
  ;(root.style as any).zoom = `${settings.zoomLevel}%`
  
  // Apply compact mode
  if (settings.compactMode) {
    root.setAttribute('data-compact-mode', 'true')
  } else {
    root.removeAttribute('data-compact-mode')
  }
  
  // Apply high contrast mode
  if (settings.highContrast) {
    root.setAttribute('data-high-contrast', 'true')
  } else {
    root.removeAttribute('data-high-contrast')
  }
  
  // Apply reduce motion
  if (settings.reduceMotion) {
    root.setAttribute('data-reduce-motion', 'true')
  } else {
    root.removeAttribute('data-reduce-motion')
  }
  
  // Apply timestamps visibility
  if (settings.showTimestamps) {
    root.setAttribute('data-show-timestamps', 'true')
  } else {
    root.removeAttribute('data-show-timestamps')
  }
  
  // Apply screen reader support
  if (settings.screenReaderSupport) {
    root.setAttribute('data-screen-reader', 'true')
  } else {
    root.removeAttribute('data-screen-reader')
  }
}

/**
 * Save settings to localStorage
 */
function saveToLocalStorage(settings: VisualThemeSettings) {
  try {
    userStorage.setItem('visual-theme', JSON.stringify(settings))
  } catch (error) {
    debug.error('Failed to save theme to localStorage:', error)
  }
}

/**
 * Load settings from localStorage
 */
function loadFromLocalStorage(): Partial<VisualThemeSettings> | null {
  try {
    const saved = userStorage.getItem('visual-theme')
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (error) {
    debug.error('Failed to load theme from localStorage:', error)
  }
  return null
}

/**
 * Get saved custom themes from localStorage
 */
function getSavedCustomThemes(): SavedCustomTheme[] {
  try {
    const saved = userStorage.getItem(SAVED_THEMES_KEY)
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (error) {
    debug.error('Failed to load saved themes from localStorage:', error)
  }
  return []
}

/**
 * Persist saved custom themes to localStorage
 */
function saveCustomThemesToStorage(themes: SavedCustomTheme[]) {
  try {
    userStorage.setItem(SAVED_THEMES_KEY, JSON.stringify(themes))
  } catch (error) {
    debug.error('Failed to save custom themes to localStorage:', error)
  }
}

/**
 * Save settings to Supabase (debounced)
 */
async function saveToSupabase(settings: VisualThemeSettings) {
  const authStore = useAuthStore()
  const userId = authStore.session?.user?.id
  
  if (!userId) return
  
  try {
    isSaving.value = true
    
    const { error } = await supabase
      .from('profiles')
      .update({
        appearance_settings: settings,
        updated_at: new Date().toISOString(),
      })
      .eq('auth_user_id', userId)
    
    if (error) throw error
    
    debug.log('✅ Visual theme settings saved to Supabase')
  } catch (error) {
    debug.error('Failed to save theme to Supabase:', error)
  } finally {
    isSaving.value = false
  }
}

/**
 * Load settings from Supabase
 * OPTIMIZED: First checks profile store to avoid redundant queries
 */
async function loadFromSupabase(): Promise<Partial<VisualThemeSettings> | null> {
  const authStore = useAuthStore()
  const profileStore = useProfileStore()
  const userId = authStore.session?.user?.id
  
  if (!userId) return null
  
  try {
    // OPTIMIZATION: Check if profile is already loaded in the store
    if (profileStore.profile?.appearance_settings) {
      debug.log('✅ Using cached appearance_settings from profile store')
      return profileStore.profile.appearance_settings as Partial<VisualThemeSettings>
    }
    
    // Fallback to direct query only if profile store doesn't have the data
    const { data, error } = await supabase
      .from('profiles')
      .select('appearance_settings')
      .eq('auth_user_id', userId)
      .maybeSingle()
    
    if (error && error.code !== 'PGRST116') throw error
    
    return data?.appearance_settings || null
  } catch (error) {
    debug.error('Failed to load theme from Supabase:', error)
    return null
  }
}

/**
 * Debounced save to Supabase
 */
function debouncedSaveToSupabase(settings: VisualThemeSettings) {
  if (saveTimeout) {
    clearTimeout(saveTimeout)
  }
  
  saveTimeout = setTimeout(() => {
    saveToSupabase(settings)
  }, 1000)
}

/**
 * Main composable
 */
export function useVisualTheme() {
  /**
   * Initialize theme system
   */
  async function initialize() {
    if (isInitialized.value) return
    
    debug.log('🎨 Initializing visual theme system...')
    
    // Try to load from localStorage first (instant)
    const localSettings = loadFromLocalStorage()
    let appliedFromLocal = false
    if (localSettings) {
      Object.assign(settings.value, localSettings)
      applySettings(settings.value)
      appliedFromLocal = true
    }
    
    // Then load from Supabase and override if different
    const supabaseSettings = await loadFromSupabase()
    if (supabaseSettings) {
      // Only re-apply if settings are actually different from localStorage
      const needsUpdate = !appliedFromLocal || 
        supabaseSettings.theme !== localSettings?.theme ||
        supabaseSettings.customAccentColor !== localSettings?.customAccentColor
      
      Object.assign(settings.value, supabaseSettings)
      
      if (needsUpdate) {
        applySettings(settings.value)
      }
      saveToLocalStorage(settings.value)
    } else if (!appliedFromLocal) {
      // No localStorage or Supabase settings - apply defaults
      applySettings(settings.value)
    }
    
    // Watch for changes and persist
    watch(
      settings,
      (newSettings) => {
        // Apply settings immediately for real-time feedback
        applySettings(newSettings)
        // Save to localStorage immediately
        saveToLocalStorage(newSettings)
        // Debounce save to Supabase
        debouncedSaveToSupabase(newSettings)
      },
      { deep: true, immediate: false }
    )
    
    isInitialized.value = true
    debug.log('✅ Visual theme system initialized')
  }
  
  /**
   * Update theme
   */
  function setTheme(theme: 'dark' | 'light' | 'midnight' | 'custom', customColor?: string, customBgColor?: string) {
    const previousTheme = settings.value.theme
    settings.value.theme = theme
    if (theme === 'custom') {
      if (customColor) {
        settings.value.customAccentColor = customColor
      }
      if (customBgColor) {
        settings.value.customBackgroundColor = customBgColor
      }
    } else if (previousTheme !== theme) {
      clearCssOverrides()
    }
  }
  
  /**
   * Update custom theme mode
   */
  function setCustomThemeMode(mode: 'dark' | 'light') {
    settings.value.customThemeMode = mode
  }
  
  /**
   * Update custom accent color
   */
  function setCustomAccentColor(color: string) {
    settings.value.theme = 'custom'
    settings.value.customAccentColor = color
  }
  
  /**
   * Update custom background color
   */
  function setCustomBackgroundColor(color: string) {
    settings.value.theme = 'custom'
    settings.value.customBackgroundColor = color
  }
  
  /**
   * Update font size
   */
  function setFontSize(size: number) {
    settings.value.fontSize = Math.max(12, Math.min(20, size))
  }
  
  /**
   * Update zoom level
   */
  function setZoomLevel(zoom: number) {
    settings.value.zoomLevel = Math.max(50, Math.min(200, zoom))
  }

  /**
   * Update UI font family. Persists via the same `appearance_settings`
   * sync flow as the rest of the theme.
   */
  function setFontFamily(family: NonNullable<VisualThemeSettings['fontFamily']>) {
    if (!FONT_STACKS[family]) return
    settings.value.fontFamily = family
  }

  /**
   * Toggle the "disable glass blur" preference.
   */
  function setDisableGlassBlur(disabled: boolean) {
    settings.value.disableGlassBlur = !!disabled
  }

  /**
   * Capture the values of every key a skin can mutate. Used to take a
   * snapshot before `applySkin` so `clearSkin` can restore them.
   */
  function snapshotSkinTargets(s: VisualThemeSettings): Partial<VisualThemeSettings> {
    return {
      theme: s.theme,
      customThemeMode: s.customThemeMode,
      customPrimaryColor: s.customPrimaryColor,
      customAccentColor: s.customAccentColor,
      customBackgroundColor: s.customBackgroundColor,
      customBackgroundLightness: s.customBackgroundLightness,
      customBackgroundChroma: s.customBackgroundChroma,
      customCssOverrides: s.customCssOverrides ? { ...s.customCssOverrides } : {},
      fontFamily: s.fontFamily,
    }
  }

  /**
   * Apply a skin by id. Merges the skin's `themeOverrides` into the live
   * settings, sets `activeSkinId`, and stashes the skin's `globalCss` in
   * `customSkinCss` so it round-trips through the `appearance_settings`
   * sync flow without needing the skin registry on the receiving device.
   *
   * The pre-skin snapshot is stored alongside the rest of settings in
   * `_preSkinSnapshot`, so it persists through reloads and across
   * devices via the `appearance_settings` JSONB column. This means
   * `clearSkin` can faithfully revert font / theme / colours even after
   * a fresh page load with a persisted active skin.
   *
   * The skin deliberately does NOT touch the user's `disableGlassBlur`
   * preference - any "this skin needs blur off" requirements are
   * enforced by the skin's own scoped CSS (`[data-skin="..."] *
   * { backdrop-filter: none }`) so the user's separate opt-out toggle
   * is preserved when they go back to "None".
   */
  function applySkin(skinId: string | null) {
    if (!skinId) {
      clearSkin()
      return
    }
    const skin = BUILTIN_SKINS.find((s) => s.id === skinId)
    if (!skin) {
      debug.warn(`applySkin: unknown skin id "${skinId}", clearing`)
      clearSkin()
      return
    }
    // Capture the pre-skin state once, only if no skin is currently
    // active. `apply A → apply B → clear` restores the state from
    // before A, not the half-skin state from between A and B.
    if (!settings.value.activeSkinId && !settings.value._preSkinSnapshot) {
      settings.value._preSkinSnapshot = snapshotSkinTargets(settings.value)
    }
    Object.assign(settings.value, skin.themeOverrides)
    settings.value.activeSkinId = skin.id
    settings.value.customSkinCss = skin.globalCss || ''
  }

  /**
   * Remove the active skin's contribution AND restore the pre-skin
   * snapshot. The snapshot is stored on `settings._preSkinSnapshot`
   * so it survives page reloads / cross-device sync.
   *
   * If no snapshot exists (e.g. a skin somehow ended up active without
   * one), fall back to the static defaults for the skin-affected keys
   * so the user still gets a clean revert.
   */
  function clearSkin() {
    const snapshot = settings.value._preSkinSnapshot
    if (snapshot) {
      Object.assign(settings.value, snapshot)
    } else if (settings.value.activeSkinId) {
      // Snapshot missing - return the skin-mutated keys to defaults.
      settings.value.theme = 'dark'
      settings.value.customCssOverrides = {}
      settings.value.fontFamily = 'system'
    }
    settings.value._preSkinSnapshot = undefined
    settings.value.activeSkinId = null
    settings.value.customSkinCss = ''
  }
  
  /**
   * Toggle settings
   */
  function toggleShowTimestamps() {
    settings.value.showTimestamps = !settings.value.showTimestamps
  }
  
  function toggle24HourTime() {
    settings.value.use24HourTime = !settings.value.use24HourTime
  }
  
  function toggleCompactMode() {
    settings.value.compactMode = !settings.value.compactMode
  }
  
  function toggleHighContrast() {
    settings.value.highContrast = !settings.value.highContrast
  }
  
  function toggleReduceMotion() {
    settings.value.reduceMotion = !settings.value.reduceMotion
  }
  
  function toggleScreenReaderSupport() {
    settings.value.screenReaderSupport = !settings.value.screenReaderSupport
  }
  
  /**
   * Bulk update settings
   */
  function updateSettings(newSettings: Partial<VisualThemeSettings>) {
    Object.assign(settings.value, newSettings)
  }
  
  /**
   * Set a single CSS variable override
   */
  function setCssOverride(varName: string, value: string) {
    if (!settings.value.customCssOverrides) {
      settings.value.customCssOverrides = {}
    }
    settings.value.customCssOverrides[varName] = value
    document.documentElement.style.setProperty(varName, value)
  }
  
  /**
   * Remove a CSS variable override
   */
  function removeCssOverride(varName: string) {
    if (settings.value.customCssOverrides) {
      delete settings.value.customCssOverrides[varName]
    }
    document.documentElement.style.removeProperty(varName)
  }
  
  /**
   * Clear all CSS variable overrides
   */
  function clearCssOverrides() {
    if (settings.value.customCssOverrides) {
      for (const varName of Object.keys(settings.value.customCssOverrides)) {
        document.documentElement.style.removeProperty(varName)
      }
    }
    settings.value.customCssOverrides = {}
  }
  
  /**
   * Apply a community preset
   */
  function applyPreset(preset: ThemePreset) {
    Object.assign(settings.value, preset.settings)
  }
  
  /**
   * Get all available CSS variable names for theming
   */
  function getThemableVariables(): { category: string; vars: string[] }[] {
    return [
      {
        category: 'Brand',
        vars: ['--harmony-primary', '--harmony-primary-hover', '--harmony-primary-light', '--harmony-secondary', '--harmony-accent', '--h-brand']
      },
      {
        category: 'Chat Surfaces',
        vars: ['--h-chat', '--h-chat-light', '--h-chat-lighter', '--h-chat-dark', '--h-chat-darker']
      },
      {
        category: 'Sidebar Surfaces',
        vars: ['--h-sidebar', '--h-sidebar-light', '--h-channel-sidebar']
      },
      {
        category: 'Dark Surfaces',
        vars: ['--h-black', '--h-black-light', '--h-black-lighter', '--h-black-darker']
      },
      {
        category: 'Primary (Layout)',
        vars: ['--h-primary', '--h-primary-light', '--h-primary-dark']
      },
      {
        category: 'Background',
        vars: ['--background-primary', '--background-secondary', '--background-tertiary', '--background-quaternary', '--background-quinary', '--background-senary']
      },
      {
        category: 'Text',
        vars: ['--text-primary', '--text-secondary', '--text-tertiary', '--text-muted']
      },
      {
        category: 'Icons',
        vars: ['--icon-active', '--icon-primary', '--icon-secondary', '--icon-tertiary', '--icon-muted']
      },
      {
        category: 'Status',
        vars: ['--status-online', '--status-away', '--status-busy', '--status-offline']
      },
      {
        category: 'Semantic',
        vars: ['--success', '--warning', '--error', '--info']
      },
      {
        category: 'Borders',
        vars: ['--border-primary', '--border-secondary', '--border-hover', '--border-focus']
      },
      {
        category: 'Alpha / Transparency',
        vars: ['--h-chat-alpha', '--h-chat-alpha-light', '--h-sidebar-alpha', '--h-black-alpha', '--background-primary-alpha', '--background-secondary-alpha', '--background-tertiary-alpha', '--background-senary-alpha']
      },
      {
        category: 'Tooltips & Overlays',
        vars: ['--tooltip-bg', '--tooltip-text', '--tooltip-arrow']
      }
    ]
  }
  
  /**
   * Reset theme system completely (call on logout)
   * This ensures the next user gets a fresh theme initialization
   */
  function reset() {
    isInitialized.value = false
    settings.value = {
      theme: 'dark',
      customThemeMode: 'dark',
      customPrimaryColor: '#0EA5E9',
      customAccentColor: '#0EA5E9',
      customBackgroundColor: '#0EA5E9',
      customBackgroundLightness: 0,
      customBackgroundChroma: 0,
      customCssOverrides: {},
      fontSize: 14,
      zoomLevel: 100,
      showTimestamps: true,
      use24HourTime: false,
      compactMode: false,
      highContrast: false,
      reduceMotion: false,
      screenReaderSupport: false,
      showCustomEmojisInDisplayNames: true,
      fontFamily: 'system',
      disableGlassBlur: false,
      activeSkinId: null,
      customSkinCss: '',
    }
    // Apply default dark theme
    applyPresetTheme('dark')
    debug.log('🎨 Visual theme reset for new user')
  }

  /**
   * Reset to defaults
   */
  function resetToDefaults() {
    settings.value = {
      theme: 'dark',
      customThemeMode: 'dark',
      customPrimaryColor: '#0EA5E9',
      customAccentColor: '#0EA5E9',
      customBackgroundColor: '#0EA5E9',
      customBackgroundLightness: 0,
      customBackgroundChroma: 0,
      customCssOverrides: {},
      fontSize: 14,
      zoomLevel: 100,
      showTimestamps: true,
      use24HourTime: false,
      compactMode: false,
      highContrast: false,
      reduceMotion: false,
      screenReaderSupport: false,
      showCustomEmojisInDisplayNames: true,
      fontFamily: 'system',
      disableGlassBlur: false,
      activeSkinId: null,
      customSkinCss: '',
    }
  }
  
  /**
   * Update custom primary color
   */
  function setCustomPrimaryColor(color: string) {
    settings.value.theme = 'custom'
    settings.value.customPrimaryColor = color
  }
  
  /**
   * Update custom background lightness
   */
  function setCustomBackgroundLightness(lightness: number) {
    settings.value.customBackgroundLightness = Math.max(-50, Math.min(50, lightness))
  }
  
  /**
   * Update custom background chroma (saturation)
   */
  function setCustomBackgroundChroma(chroma: number) {
    settings.value.customBackgroundChroma = Math.max(-30, Math.min(30, chroma))
  }
  
  /**
   * Get current settings
   */
  const currentSettings = computed(() => ({ ...settings.value }))
  
  /**
   * Export current theme as JSON string (for custom themes)
   */
  function exportThemeAsJson(): string {
    const themeOnly: Partial<VisualThemeSettings> = {
      theme: settings.value.theme,
      customThemeMode: settings.value.customThemeMode,
      customPrimaryColor: settings.value.customPrimaryColor,
      customAccentColor: settings.value.customAccentColor,
      customBackgroundColor: settings.value.customBackgroundColor,
      customBackgroundLightness: settings.value.customBackgroundLightness,
      customBackgroundChroma: settings.value.customBackgroundChroma,
      customCssOverrides: settings.value.customCssOverrides ? { ...settings.value.customCssOverrides } : undefined,
    }
    return JSON.stringify(themeOnly, null, 2)
  }
  
  /**
   * Import and apply theme from JSON string
   */
  function importThemeFromJson(json: string): boolean {
    try {
      const parsed = JSON.parse(json) as Partial<VisualThemeSettings>
      if (!parsed || typeof parsed !== 'object') return false
      // Ensure we're in custom mode and merge theme-relevant fields
      const toApply: Partial<VisualThemeSettings> = {
        theme: 'custom',
        customThemeMode: parsed.customThemeMode ?? 'dark',
        customPrimaryColor: parsed.customPrimaryColor ?? settings.value.customPrimaryColor,
        customAccentColor: parsed.customAccentColor ?? settings.value.customAccentColor,
        customBackgroundColor: parsed.customBackgroundColor ?? settings.value.customBackgroundColor,
        customBackgroundLightness: parsed.customBackgroundLightness ?? settings.value.customBackgroundLightness,
        customBackgroundChroma: parsed.customBackgroundChroma ?? settings.value.customBackgroundChroma,
        customCssOverrides: parsed.customCssOverrides ? { ...parsed.customCssOverrides } : undefined,
      }
      Object.assign(settings.value, toApply)
      return true
    } catch {
      return false
    }
  }
  
  /**
   * Save current theme to "My themes" in localStorage
   */
  function saveCurrentThemeAsCustom(name: string): SavedCustomTheme | null {
    if (!name?.trim()) return null
    const theme: SavedCustomTheme = {
      id: crypto.randomUUID(),
      name: name.trim(),
      settings: {
        theme: 'custom',
        customThemeMode: settings.value.customThemeMode,
        customPrimaryColor: settings.value.customPrimaryColor,
        customAccentColor: settings.value.customAccentColor,
        customBackgroundColor: settings.value.customBackgroundColor,
        customBackgroundLightness: settings.value.customBackgroundLightness,
        customBackgroundChroma: settings.value.customBackgroundChroma,
        customCssOverrides: settings.value.customCssOverrides ? { ...settings.value.customCssOverrides } : undefined,
      },
      createdAt: new Date().toISOString(),
    }
    const list = getSavedCustomThemes()
    list.unshift(theme)
    saveCustomThemesToStorage(list)
    return theme
  }
  
  /**
   * Load and apply a saved custom theme
   */
  function loadSavedTheme(id: string): boolean {
    const list = getSavedCustomThemes()
    const found = list.find(t => t.id === id)
    if (!found?.settings) return false
    Object.assign(settings.value, found.settings)
    settings.value.theme = 'custom'
    return true
  }
  
  /**
   * Delete a saved custom theme
   */
  function deleteSavedTheme(id: string): void {
    const list = getSavedCustomThemes().filter(t => t.id !== id)
    saveCustomThemesToStorage(list)
  }
  
  /**
   * Apply instance default theme if the user has no custom theme set.
   * Called on app init for new / unauthenticated users.
   */
  function loadInstanceDefaultTheme(themeJson: string | null): boolean {
    if (!themeJson) return false
    if (settings.value.theme !== 'dark') return false
    return importThemeFromJson(themeJson)
  }

  return {
    // State
    settings: computed(() => settings.value),
    isInitialized: computed(() => isInitialized.value),
    isSaving: computed(() => isSaving.value),
    
    // Methods
    initialize,
    loadInstanceDefaultTheme,
    setTheme,
    setCustomThemeMode,
    setCustomPrimaryColor,
    setCustomAccentColor,
    setCustomBackgroundColor,
    setCustomBackgroundLightness,
    setCustomBackgroundChroma,
    setFontSize,
    setZoomLevel,
    setFontFamily,
    setDisableGlassBlur,
    applySkin,
    clearSkin,
    toggleShowTimestamps,
    toggle24HourTime,
    toggleCompactMode,
    toggleHighContrast,
    toggleReduceMotion,
    toggleScreenReaderSupport,
    updateSettings,
    resetToDefaults,
    reset,
    currentSettings,
    setCssOverride,
    removeCssOverride,
    clearCssOverrides,
    applyPreset,
    getThemableVariables,
    exportThemeAsJson,
    importThemeFromJson,
    getSavedCustomThemes,
    saveCurrentThemeAsCustom,
    loadSavedTheme,
    deleteSavedTheme,
  }
}

