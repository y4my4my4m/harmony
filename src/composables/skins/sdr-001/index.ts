/**
 * SDR-001 / NEO KOBE 1988
 *
 * Snatcher-era noir: blood red and slate steel on blue-black surfaces, pixel
 * type, square frames. CSS lives in `./skin.css`, loaded on first use
 * through Vite's `?raw` query.
 *
 * Assets:
 *   public/assets/skins/sdr-001-preview.png   picker thumbnail
 *   public/assets/skins/sdr-001/icons/        pixelarticons (MIT) for CSS masks
 *   public/assets/sounds/neokobe/             linked audio theme
 */
import type { Skin } from '../types'

export const sdr001Skin: Skin = {
  id: 'sdr-001',
  name: 'SDR-001 / Neo Kobe 1988',
  description:
    'Noir cyberpunk after Snatcher: blood-red accents and slate-steel labels ' +
    'on blue-black night surfaces, pixel typography, square frames with hard ' +
    'drop shadows, pixel-art icons and an optional CRT scanline overlay. ' +
    'Pairs with the Neo Kobe sound pack. Toggle the decorations below.',
  isBeta: true,
  preview: '/assets/skins/sdr-001-preview.png',
  options: [
    {
      id: 'scanline',
      label: 'CRT scanlines',
      description:
        'Static horizontal-line overlay across the viewport. Off while blur ' +
        'effects are disabled.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'viewport-frame',
      label: 'Viewport edge frame',
      description: 'Hairline red border pinned to the screen edges.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'hud-badge',
      label: 'SDR-001 HUD badge',
      description: 'Small "SDR-001" tag in the top-right corner on wide screens.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'tactical-labels',
      label: 'Tactical text labels',
      description:
        'Terminal readouts: "//" before channel categories, a cursor on the ' +
        'open channel, "COMMS //" on the voice dock, "TRANSMISSION //" on ' +
        'the voice overlay and bracketed status on the user bar.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'icon-flicker',
      label: 'Icon flicker and cursor blink',
      description:
        'Occasional CRT flicker on rail icons and a blinking channel cursor. ' +
        'Off when reduced motion is requested.',
      type: 'boolean',
      default: true,
    },
  ],
  linkedAudioTheme: 'neokobe',
  themeOverrides: {
    theme: 'custom',
    customThemeMode: 'dark',
    customPrimaryColor: '#DC143C',
    customAccentColor: '#DC143C',
    // Supplies the surface hue only (OKLCH ~265, slate blue); lightness and
    // chroma come from the two offsets below.
    customBackgroundColor: '#1B2231',
    customBackgroundLightness: 0,
    customBackgroundChroma: 2,
    // Surfaces stay palette-derived; pinning --harmony-*, --text-* or
    // --border-* here would lock the theme editor out after apply.
    customCssOverrides: {},
    fontFamily: 'pixel',
  },
  loadCss: () => import('./skin.css?raw').then((m) => m.default),
}
