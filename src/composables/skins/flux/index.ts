/**
 * Flux
 *
 * Liquid glass over a drifting metaball field, in a horizontal layout: a
 * server dock across the top, channels as a tab strip, a centred
 * conversation. The layout is CSS over the data-region hooks; the scene
 * (./scene.ts) draws the field, provides the lens filter and positions dock
 * tooltips. CSS in `./skin.css` and the scene load on first use through
 * dynamic imports.
 *
 * Assets:
 *   public/assets/skins/flux-preview.svg   picker thumbnail
 *   public/assets/sounds/flux/             linked audio theme
 *                                          (scripts/sound-packs/flux.mjs)
 */
import type { Skin } from '../types'

export const fluxSkin: Skin = {
  id: 'flux',
  name: 'Flux',
  description:
    'Liquid glass and a new layout. Servers float in a glass dock across the ' +
    'top, channels run as a tab strip, the conversation sits in a centred ' +
    'column under a glass prompt, all over a drifting metaball field. Glass ' +
    'has thickness, rim light and colour fringing, and bends what is behind ' +
    'it where the browser allows. Takes your primary and accent colours. ' +
    'Pairs with the Flux sound pack of resonant liquid synth.',
  isBeta: true,
  preview: '/assets/skins/flux-preview.svg',
  options: [
    {
      id: 'dock',
      label: 'Horizontal layout',
      description:
        'Servers in a dock across the top, channels as a tab strip, the ' +
        'conversation in a centred column and you in a capsule at the top ' +
        'right. Windows narrower than 1024px keep the side-by-side layout. ' +
        'Reorder servers with this off.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'lens',
      label: 'Lens refraction',
      description:
        'Glass controls bend what is behind their rims. Chromium-based ' +
        'browsers and the Windows app only; elsewhere the glass keeps its ' +
        'rim light without the bend.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'liquid',
      label: 'Liquid field',
      description: 'Metaballs drifting behind the glass. Off leaves a still aurora.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'drift',
      label: 'Living drift',
      description:
        'The field moves at 20 frames a second while the window is focused. ' +
        'Off, it holds still and draws only when something changes.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'orbits',
      label: 'Orbit rings',
      description: 'Thin colour rings turning slowly behind the liquid.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'morph',
      label: 'Morphing shapes',
      description: 'Servers and avatars melt into moving blobs under the pointer.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'ui-sounds',
      label: 'Interface sounds',
      description: 'A liquid blip on button and list clicks, from the active sound pack.',
      type: 'boolean',
      default: true,
    },
  ],
  linkedAudioTheme: 'flux',
  themeOverrides: {
    theme: 'custom',
    customThemeMode: 'dark',
    customPrimaryColor: '#7C5CFF',
    customAccentColor: '#22E1D3',
    // Hue only (OKLCH ~285, indigo); the offsets push the surfaces to
    // near-black.
    customBackgroundColor: '#2A2350',
    customBackgroundLightness: -14,
    customBackgroundChroma: 2,
    // '' rather than undefined: resolveSkin copies overrides through JSON,
    // which drops undefined keys and would keep a stored sidebar hue.
    customSidebarColor: '',
    customCssOverrides: {},
    fontFamily: 'system',
  },
  loadCss: () => import('./skin.css?raw').then((m) => m.default),
  loadScene: () => import('./scene').then((m) => m.default),
}
