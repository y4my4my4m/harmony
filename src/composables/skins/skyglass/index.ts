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
 *   public/assets/skins/skyglass/meadow.webp   day wallpaper
 *   public/assets/skins/skyglass/lagoon.webp   night wallpaper
 *   public/assets/sounds/skyglass/             linked audio theme
 *                                              (scripts/sound-packs/skyglass.mjs)
 */
import type { Skin } from '../types'

export const skyglassSkin: Skin = {
  id: 'skyglass',
  name: 'Skyglass',
  description:
    'Glossy, airy and bright: frosted-glass panels floating over a sky of ' +
    'clouds, light rays and bubbles, or a painted meadow. Gel buttons, ' +
    'glass-orb servers and avatars, chat bubbles and springy menus. Switch the ' +
    'theme to dark for a night lagoon; primary and accent recolour the drawn ' +
    'sky. Pairs with the Skyglass sound pack of glass bells and water drops.',
  descriptionKey: 'settings.appearance.skins.skyglass.description',
  isBeta: true,
  preview: '/assets/skins/skyglass-preview.svg',
  options: [
    {
      id: 'sky',
      label: 'Sky scene',
      labelKey: 'settings.appearance.skins.skyglass.options.sky.label',
      description:
        'Clouds, sun glow and light rays over the drawn sky, with the painted ' +
        'wallpaper off. Off leaves a plain gradient.',
      descriptionKey: 'settings.appearance.skins.skyglass.options.sky.description',
      type: 'boolean',
      default: true,
    },
    {
      id: 'wallpaper',
      label: 'Painted wallpaper',
      labelKey: 'settings.appearance.skins.skyglass.options.wallpaper.label',
      description:
        'A meadow of glossy grass, bubbles and light ribbons; an aurora lagoon in ' +
        'dark theme. Off draws the sky from the theme colours.',
      descriptionKey: 'settings.appearance.skins.skyglass.options.wallpaper.description',
      type: 'boolean',
      default: false,
    },
    {
      id: 'bubbles',
      label: 'Bubbles',
      labelKey: 'settings.appearance.skins.skyglass.options.bubbles.label',
      description: 'Glossy bubbles floating in the backdrop.',
      descriptionKey: 'settings.appearance.skins.skyglass.options.bubbles.description',
      type: 'boolean',
      default: true,
    },
    {
      id: 'drift',
      label: 'Drifting bubbles',
      labelKey: 'settings.appearance.skins.skyglass.options.drift.label',
      description:
        'Bubbles rise slowly. Keeps the GPU busy while glass blur is on; off ' +
        'when reduced motion is requested.',
      descriptionKey: 'settings.appearance.skins.skyglass.options.drift.description',
      type: 'boolean',
      default: false,
    },
    {
      id: 'gloss',
      label: 'Gel gloss',
      labelKey: 'settings.appearance.skins.skyglass.options.gloss.label',
      description: 'Split highlights on buttons, badges, server orbs and avatars.',
      descriptionKey: 'settings.appearance.skins.skyglass.options.gloss.description',
      type: 'boolean',
      default: true,
    },
    {
      id: 'chat-bubbles',
      label: 'Chat bubbles',
      labelKey: 'settings.appearance.skins.skyglass.options.chatBubbles.label',
      description: 'Message text sits in glass bubbles instead of flat rows.',
      descriptionKey: 'settings.appearance.skins.skyglass.options.chatBubbles.description',
      type: 'boolean',
      default: true,
    },
    {
      id: 'ui-sounds',
      label: 'Interface sounds',
      labelKey: 'settings.appearance.skins.skyglass.options.uiSounds.label',
      description: 'A soft droplet on button and list clicks, from the active sound pack.',
      descriptionKey: 'settings.appearance.skins.skyglass.options.uiSounds.description',
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
