/**
 * SDR-001 / NEO KOBE 1988 skin. CSS lives in `./skin.css`, imported via
 * Vite's `?raw` query for editor syntax highlighting.
 *
 * Asset convention:
 *   src/composables/skins/<skin-id>/skin.css       # global rules
 *   src/composables/skins/<skin-id>/index.ts       # Skin export
 *   public/assets/skins/<skin-id>/...              # static assets
 *     - <skin-id>-preview.png                      # picker thumbnail
 *     - icons/                                     # optional CSS-mask icons
 *     - bg/                                        # optional backgrounds
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
  // Each option flips a `data-skin-<id>="on|off"` attribute on `<html>` gating CSS rules.
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
    // --border-* in customCssOverrides - that blocks the theme editor
    // from updating the skin after apply.
    customCssOverrides: {},
    fontFamily: 'pixel',
  },
  globalCss: skinCss,
}
