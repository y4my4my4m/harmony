/**
 * Skyglass
 *
 * Frosted-glass panels over a sky backdrop: gel buttons with a split
 * highlight, glossy orbs for servers and avatars, aqua scrollbars and
 * springy popovers. Light mode is a daytime sky; dark mode is a night
 * lagoon. Sky, glass tint and gel fills follow the theme's primary and
 * accent, so the theme editor recolours the whole skin. CSS lives in
 * `./skin.css`, loaded on first use through Vite's `?raw` query.
 *
 * Assets:
 *   public/assets/skins/skyglass-preview.svg   picker thumbnail
 *   public/assets/sounds/skyglass/             linked audio theme
 *                                              (scripts/sound-packs/skyglass.mjs)
 */
import type { Skin } from '../types'

export const skyglassSkin: Skin = {
  id: 'skyglass',
  name: 'Skyglass',
  description:
    'Glossy, airy and bright: frosted-glass panels floating over a sky of ' +
    'clouds, light rays and bubbles. Gel buttons, glass-orb servers and ' +
    'avatars, chat bubbles and springy menus. Switch the theme to dark for a ' +
    'night lagoon; primary and accent recolour the sky. Pairs with the ' +
    'Skyglass sound pack of glass bells and water drops.',
  isBeta: true,
  preview: '/assets/skins/skyglass-preview.svg',
  options: [
    {
      id: 'sky',
      label: 'Sky scene',
      description: 'Clouds, sun glow and light rays behind the glass. Off leaves a plain gradient.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'bubbles',
      label: 'Bubbles',
      description: 'Glossy bubbles floating in the backdrop.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'drift',
      label: 'Drifting bubbles',
      description:
        'Bubbles rise slowly. Keeps the GPU busy while glass blur is on; off ' +
        'when reduced motion is requested.',
      type: 'boolean',
      default: false,
    },
    {
      id: 'gloss',
      label: 'Gel gloss',
      description: 'Split highlights on buttons, badges, server orbs and avatars.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'chat-bubbles',
      label: 'Chat bubbles',
      description: 'Message text sits in glass bubbles instead of flat rows.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'ui-sounds',
      label: 'Interface sounds',
      description: 'A soft droplet on button and list clicks, from the active sound pack.',
      type: 'boolean',
      default: true,
    },
  ],
  linkedAudioTheme: 'skyglass',
  themeOverrides: {
    theme: 'custom',
    customThemeMode: 'light',
    customPrimaryColor: '#0A7CFF',
    customAccentColor: '#2DB84D',
    // Hue only (OKLCH ~250, sky blue); the offsets set a pale blue tint.
    customBackgroundColor: '#8CC8FF',
    customBackgroundLightness: 0,
    customBackgroundChroma: 8,
    // '' rather than undefined: resolveSkin copies overrides through JSON,
    // which drops undefined keys and would keep a stored sidebar hue.
    customSidebarColor: '',
    customCssOverrides: {},
    fontFamily: 'system',
  },
  loadCss: () => import('./skin.css?raw').then((m) => m.default),
}
