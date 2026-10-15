/**
 * Paper
 *
 * The paper desktop of the v2 site: newsprint desk, warm ink, 1-bit window
 * chrome. Dialogs, the settings window and the profile card carry a striped
 * title strip with a square close box; the chat is a framed window whose
 * header is its title bar. Frames are 2px ink on hard ink offsets with no
 * blur. The mascot blue is a fill, red-orange marks mentions, unread and
 * danger, and a highlighter marks the open channel, hovered rows and
 * mentions. Code prints on a dark screen. Dark mode inverts the chrome: pale
 * frames on a dark desk. CSS lives in `./skin.css`, loaded on first use
 * through Vite's `?raw` query.
 *
 * Assets:
 *   public/assets/skins/paper-preview.svg   picker thumbnail
 *   public/assets/skins/paper/glyphs.svg    glyph wallpaper
 *                                           (scripts/skins/paper-glyphs.mjs)
 *   public/assets/fonts/paper/              Bricolage Grotesque, Instrument
 *                                           Sans, Martian Mono (OFL-1.1);
 *                                           declared in skin.css, so fetched
 *                                           only while it is active
 */
import type { Skin } from '../types'

export const paperSkin: Skin = {
  id: 'paper',
  name: 'Paper',
  description:
    'A paper desktop with 1-bit windows: newsprint desk, warm ink and the ' +
    'mascot blue. Dialogs and settings open as windows with a striped title ' +
    'bar and a square close box, the chat sits in a framed window, and every ' +
    'frame casts a hard ink shadow. A highlighter marks the open channel and ' +
    'your mentions, headings are a heavy condensed grotesque, labels and ' +
    'times are monospaced and code prints on a dark screen. Switch the theme ' +
    'to dark for pale frames on a dark desk.',
  isBeta: true,
  preview: '/assets/skins/paper-preview.svg',
  options: [
    {
      id: 'shadows',
      label: 'Ink shadows',
      description:
        'Hard offset shadows under windows, menus, buttons and server icons. ' +
        'Off leaves the ink frames flat on the desk.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'jelly',
      label: 'Jelly motion',
      description:
        'Buttons, reactions and server icons squash and settle when you ' +
        'point at them. Off when reduced motion is requested.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'grain',
      label: 'Paper grain',
      description: 'Fine noise across the desk behind the windows.',
      type: 'boolean',
      default: true,
    },
    {
      id: 'glyphs',
      label: 'Glyph wallpaper',
      description:
        'Faint monospaced chat text behind the messages, laid along the ' +
        'nodal lines of a vibrating plate. Static.',
      type: 'boolean',
      default: false,
    },
  ],
  themeOverrides: {
    theme: 'custom',
    customThemeMode: 'light',
    // The brand blue fill, never darkened; text-size blue and red come from
    // skin.css.
    customPrimaryColor: '#0EA5E9',
    customAccentColor: '#EB4E2C',
    // Hue only (OKLCH ~85, warm newsprint); skin.css paints the surfaces.
    customBackgroundColor: '#F3EEE3',
    customBackgroundLightness: 0,
    customBackgroundChroma: 0,
    // '' rather than undefined: resolveSkin copies overrides through JSON,
    // which drops undefined keys and would keep a stored sidebar hue.
    customSidebarColor: '',
    customCssOverrides: {},
    fontFamily: 'system',
  },
  loadCss: () => import('./skin.css?raw').then((m) => m.default),
}
