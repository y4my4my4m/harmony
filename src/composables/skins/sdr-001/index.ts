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
    'tactical HUD frames around panels, a CRT scanline overlay, and a ' +
    'voice-chat panel that reads like a tap-dispatch console. The skin ' +
    'no longer overrides your blur preference - re-enable Effects > ' +
    'Disable blur off and modals will frost over again.',
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
  },
  globalCss: skinCss,
}
