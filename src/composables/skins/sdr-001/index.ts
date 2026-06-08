/**
 * SDR-001 / NEO KOBE 1988 skin
 *
 * Cyberpunk-noir aesthetic. CSS lives in `./skin.css` (imported via Vite's
 * `?raw` query so the file gets regular CSS syntax highlighting in the
 * editor and stays out of the TypeScript source). Theme overrides are
 * declared inline below so the skin is fully described by this folder.
 *
 * Asset convention (for future additions):
 *   src/composables/skins/<skin-id>/skin.css       # global rules
 *   src/composables/skins/<skin-id>/index.ts       # Skin export
 *   public/assets/skins/<skin-id>/...              # static assets
 *     - <skin-id>-preview.png                      # picker thumbnail
 *     - icons/                                     # optional CSS-mask icons
 *     - bg/                                        # optional backgrounds
 *
 * To add a new skin: copy this folder, swap the CSS + theme overrides,
 * register the export in `../index.ts`. No TypeScript branches, no
 * if/else - the registry is just an array.
 */
import type { Skin } from '../types'
import skinCss from './skin.css?raw'

export const sdr001Skin: Skin = {
  id: 'sdr-001',
  name: 'SDR-001 / Neo Kobe 1988',
  description:
    'A noir-cyberpunk skin: blood-red accents, sharp pixel typography, ' +
    'tactical HUD frames around panels, an optional CRT scanline overlay, ' +
    'and a voice-chat panel that reads like a tap-dispatch console. ' +
    'Use the toggles below to enable / disable individual decorations.',
  isBeta: true,
  preview: '/assets/skins/sdr-001-preview.png',
  // Each option flips a `data-skin-<id>="on|off"` attribute on `<html>`
  // that the skin's CSS gates decorative rules on. Defaults are all `on`
  // because the user picked the skin to get the costume; toggle off for
  // a quieter version of the same look.
  options: [
    {
      id: 'scanline',
      label: 'CRT scanlines',
      description: 'Subtle horizontal-line overlay across the whole viewport.',
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
      description: 'Small "SDR-001" identifier in the top-right corner.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'tactical-labels',
      label: 'Tactical text labels',
      description:
        'Decorative readouts: "TX/RX READY" on the voice dock, ' +
        '"COMMS //" on the channel name, "▶ TRANSMISSION //" on the ' +
        'voice overlay, "── SUBJECT ID ──" / latency line on the user bar.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'icon-flicker',
      label: 'Server-icon flicker',
      description:
        'Occasional CRT-style flicker on the Harmony logo and server icons. ' +
        'Always disabled when the OS prefers reduced motion.',
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
    customBackgroundColor: '#DC143C',
    customBackgroundLightness: 5,
    customBackgroundChroma: -6,
    // Colour tokens are derived from the palette (customPrimaryColor +
    // background sliders above). Do not pin --harmony-* / --text-* /
    // --border-* in customCssOverrides — that blocks the theme editor
    // from updating the skin after apply.
    customCssOverrides: {},
    fontFamily: 'pixel',
  },
  globalCss: skinCss,
}
