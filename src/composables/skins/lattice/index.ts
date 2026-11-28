/**
 * Lattice
 *
 * Engineering-grade AI console: every region floats as its own frame on a
 * dotted canvas, labels are monospaced caps, controls are inverted pills, and
 * a holographic edge lights the prompt bar and the active server. Dark mode
 * is obsidian; light mode is bone paper with hard black frames. The theme's
 * primary is the single signal colour. Layout moves through the data-region
 * hooks (see ../index.ts); no component knows this skin exists. CSS lives in
 * `./skin.css`, loaded on first use through Vite's `?raw` query.
 *
 * Assets:
 *   public/assets/skins/lattice-preview.svg   picker thumbnail
 *   public/assets/sounds/lattice/             linked audio theme
 *                                             (scripts/sound-packs/lattice.mjs)
 */
import type { Skin } from '../types'

export const latticeSkin: Skin = {
  id: 'lattice',
  name: 'Lattice',
  description:
    'Crystal-and-concrete AI console: floating framed panels on a dotted ' +
    'canvas, monospaced labels, inverted pill buttons, a centred conversation ' +
    'column with a holographic prompt bar, and one signal colour. Obsidian in ' +
    'dark mode, bone paper with black frames in light. Pairs with the Lattice ' +
    'sound pack of FM crystal pings and relay ticks.',
  descriptionKey: 'settings.appearance.skins.lattice.description',
  isBeta: true,
  preview: '/assets/skins/lattice-preview.svg',
  options: [
    {
      id: 'bento',
      label: 'Floating panels',
      labelKey: 'settings.appearance.skins.lattice.options.bento.label',
      description: 'Rail, channels, header, chat and members as separate frames with gaps. Off joins them edge to edge.',
      descriptionKey: 'settings.appearance.skins.lattice.options.bento.description',
      type: 'boolean',
      default: true,
    },
    {
      id: 'focus-column',
      label: 'Centred conversation',
      labelKey: 'settings.appearance.skins.lattice.options.focusColumn.label',
      description: 'Messages and the prompt bar in a centred reading column on wide windows.',
      descriptionKey: 'settings.appearance.skins.lattice.options.focusColumn.description',
      type: 'boolean',
      default: true,
    },
    {
      id: 'prism',
      label: 'Holographic accents',
      labelKey: 'settings.appearance.skins.lattice.options.prism.label',
      description: 'Iridescent glow on the canvas, the prompt bar edge, the active server and channel titles. Off is pure monochrome.',
      descriptionKey: 'settings.appearance.skins.lattice.options.prism.description',
      type: 'boolean',
      default: true,
    },
    {
      id: 'marks',
      label: 'Registration marks',
      labelKey: 'settings.appearance.skins.lattice.options.marks.label',
      description: 'Corner brackets on every frame and numbered channel categories.',
      descriptionKey: 'settings.appearance.skins.lattice.options.marks.description',
      type: 'boolean',
      default: true,
    },
    {
      id: 'drift',
      label: 'Drifting glow',
      labelKey: 'settings.appearance.skins.lattice.options.drift.label',
      description: 'The holographic glow moves slowly. Off when reduced motion is requested.',
      descriptionKey: 'settings.appearance.skins.lattice.options.drift.description',
      type: 'boolean',
      default: false,
    },
    {
      id: 'ui-sounds',
      label: 'Interface sounds',
      labelKey: 'settings.appearance.skins.lattice.options.uiSounds.label',
      description: 'A relay tick on button and list clicks, from the active sound pack.',
      descriptionKey: 'settings.appearance.skins.lattice.options.uiSounds.description',
      type: 'boolean',
      default: true,
    },
  ],
  linkedAudioTheme: 'lattice',
  themeOverrides: {
    theme: 'custom',
    customThemeMode: 'dark',
    customPrimaryColor: '#FF5A1F',
    customAccentColor: '#B9A6FF',
    // Hue only (OKLCH ~75, warm grey); the offsets push the surfaces to
    // near-black and near-neutral.
    customBackgroundColor: '#8C8270',
    customBackgroundLightness: -10,
    customBackgroundChroma: -4,
    // '' rather than undefined: resolveSkin copies overrides through JSON,
    // which drops undefined keys and would keep a stored sidebar hue.
    customSidebarColor: '',
    customCssOverrides: {},
    fontFamily: 'system',
  },
  loadCss: () => import('./skin.css?raw').then((m) => m.default),
}
