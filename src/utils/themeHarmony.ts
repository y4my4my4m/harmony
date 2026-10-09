/**
 * Palette suggestions for the custom theme editor.
 *
 * A suggestion is the set of fields the editor stores for a custom theme:
 * background tone (hue plus the lightness and saturation slider offsets),
 * primary and accent. Hues come from a harmony scheme around a seed hue;
 * lightness and chroma come from a mood. Every colour is gamut-mapped in
 * OKLCH, so a vivid mood keeps its hue instead of clipping.
 *
 * Pure: no DOM. Image extraction takes RGBA pixels the caller has read.
 */
import {
  composeBackgroundToneHex,
  contrastRatio,
  ensureContrast,
  generatePreviewColors,
  hexToOklch,
  oklchToHexInGamut,
  primarySurfaceHex,
  rgbToOklch,
} from './colorUtils'

export type ThemeMode = 'dark' | 'light'

export type HarmonyScheme = 'mono' | 'analogous' | 'complement' | 'split' | 'triad' | 'dusk'

export type PaletteMood = 'soft' | 'balanced' | 'vivid' | 'neon'

export interface ThemeColors {
  customThemeMode: ThemeMode
  customBackgroundColor: string
  customBackgroundLightness: number
  customBackgroundChroma: number
  customPrimaryColor: string
  customAccentColor: string
}

export interface PaletteSuggestion {
  id: string
  label: string
  colors: ThemeColors
  /** Chat surface, sidebar surface, header surface, primary, accent. */
  preview: { main: string; sidebar: string; header: string; primary: string; accent: string }
}

/**
 * Hue offsets from the seed, in degrees: background, primary, accent.
 * Primary always sits on the seed so the colour the user picked stays put.
 */
export const HARMONY_SCHEMES: Record<HarmonyScheme, { label: string; bg: number; accent: number }> = {
  mono: { label: 'Mono', bg: 0, accent: 0 },
  analogous: { label: 'Analogous', bg: -30, accent: 35 },
  complement: { label: 'Complement', bg: 0, accent: 180 },
  split: { label: 'Split', bg: 0, accent: 150 },
  triad: { label: 'Triad', bg: 120, accent: 240 },
  dusk: { label: 'Dusk', bg: 180, accent: 40 },
}

interface MoodLevels {
  /** Background slider offsets, editor units (-50..50, -30..30). */
  bgLightness: number
  bgChroma: number
  /** Primary and accent target in OKLCH (L in %, chroma before gamut mapping). */
  primaryL: number
  primaryC: number
  accentL: number
  accentC: number
}

/**
 * Per-mode targets. Dark primaries sit at L 64-74 so a white label still
 * clears 2.6:1 on most hues; light primaries at L 50-60 so they read as text
 * on near-white surfaces.
 */
export const PALETTE_MOODS: Record<PaletteMood, { label: string; dark: MoodLevels; light: MoodLevels }> = {
  soft: {
    label: 'Soft',
    dark: { bgLightness: -2, bgChroma: 1, primaryL: 72, primaryC: 0.1, accentL: 78, accentC: 0.08 },
    light: { bgLightness: 0, bgChroma: 3, primaryL: 58, primaryC: 0.1, accentL: 60, accentC: 0.08 },
  },
  balanced: {
    label: 'Balanced',
    dark: { bgLightness: 0, bgChroma: 5, primaryL: 66, primaryC: 0.16, accentL: 74, accentC: 0.13 },
    light: { bgLightness: -2, bgChroma: 6, primaryL: 55, primaryC: 0.16, accentL: 57, accentC: 0.13 },
  },
  vivid: {
    label: 'Vivid',
    dark: { bgLightness: 4, bgChroma: 12, primaryL: 66, primaryC: 0.22, accentL: 76, accentC: 0.18 },
    light: { bgLightness: -5, bgChroma: 14, primaryL: 54, primaryC: 0.22, accentL: 56, accentC: 0.18 },
  },
  neon: {
    label: 'Neon',
    dark: { bgLightness: -12, bgChroma: 8, primaryL: 74, primaryC: 0.3, accentL: 84, accentC: 0.24 },
    light: { bgLightness: -8, bgChroma: 20, primaryL: 58, primaryC: 0.3, accentL: 60, accentC: 0.26 },
  },
}

const wrapHue = (h: number) => ((h % 360) + 360) % 360

/** Primary and accent as text and icons on --background-primary: 3:1, the WCAG floor for large text and UI. */
const PRIMARY_ON_SURFACE_MIN = 3

function buildColors(
  seedHue: number,
  scheme: HarmonyScheme,
  mood: PaletteMood,
  mode: ThemeMode,
): ThemeColors {
  const s = HARMONY_SCHEMES[scheme]
  const m = PALETTE_MOODS[mood][mode]
  const bgHue = wrapHue(seedHue + s.bg)
  const accentHue = wrapHue(seedHue + s.accent)
  // Mono separates accent from primary by lightness instead of hue.
  const accentL = scheme === 'mono' ? m.accentL + (mode === 'dark' ? 8 : -10) : m.accentL
  const background = composeBackgroundToneHex(bgHue, m.bgLightness, m.bgChroma, mode)
  const surface = primarySurfaceHex(background, mode, m.bgLightness, m.bgChroma)
  const primary = ensureContrast(
    oklchToHexInGamut(m.primaryL, m.primaryC, wrapHue(seedHue)),
    surface,
    PRIMARY_ON_SURFACE_MIN,
  )
  const accent = ensureContrast(
    oklchToHexInGamut(accentL, m.accentC, accentHue),
    surface,
    PRIMARY_ON_SURFACE_MIN,
  )
  return {
    customThemeMode: mode,
    customBackgroundColor: background,
    customBackgroundLightness: m.bgLightness,
    customBackgroundChroma: m.bgChroma,
    customPrimaryColor: primary.toUpperCase(),
    customAccentColor: accent.toUpperCase(),
  }
}

function previewOf(colors: ThemeColors): PaletteSuggestion['preview'] {
  const p = generatePreviewColors(
    colors.customBackgroundColor,
    colors.customThemeMode,
    colors.customBackgroundLightness,
    colors.customBackgroundChroma,
  )
  return {
    main: p.bgMain,
    sidebar: p.bgSidebar,
    header: p.bgHeader,
    primary: colors.customPrimaryColor,
    accent: colors.customAccentColor,
  }
}

/** One suggestion per harmony scheme around `seedHex`. Invalid seed: empty list. */
export function suggestPalettes(seedHex: string, mode: ThemeMode, mood: PaletteMood): PaletteSuggestion[] {
  const seed = hexToOklch(seedHex)
  if (!seed) return []
  // Near-grey seeds have no meaningful hue; OKLCH reports noise there.
  const seedHue = seed.c < 0.02 ? 250 : seed.h
  return (Object.keys(HARMONY_SCHEMES) as HarmonyScheme[]).map((scheme) => {
    const colors = buildColors(seedHue, scheme, mood, mode)
    return { id: `${scheme}-${mood}-${mode}`, label: HARMONY_SCHEMES[scheme].label, colors, preview: previewOf(colors) }
  })
}

const MOOD_WEIGHTS: [PaletteMood, number][] = [
  ['soft', 2],
  ['balanced', 4],
  ['vivid', 3],
  ['neon', 1],
]

/** A random seed hue, scheme and mood. `rand` returns [0, 1). */
export function randomPalette(mode: ThemeMode, rand: () => number = Math.random): PaletteSuggestion {
  const schemes = Object.keys(HARMONY_SCHEMES) as HarmonyScheme[]
  const scheme = schemes[Math.floor(rand() * schemes.length) % schemes.length]
  const total = MOOD_WEIGHTS.reduce((n, [, w]) => n + w, 0)
  let pick = rand() * total
  let mood: PaletteMood = 'balanced'
  for (const [m, w] of MOOD_WEIGHTS) {
    if ((pick -= w) < 0) {
      mood = m
      break
    }
  }
  const colors = buildColors(rand() * 360, scheme, mood, mode)
  return { id: `random-${scheme}-${mood}`, label: HARMONY_SCHEMES[scheme].label, colors, preview: previewOf(colors) }
}

// ---------------------------------------------------------------------------
// Image palettes

export interface ImageSwatch {
  hex: string
  /** Share of sampled pixels, 0..1. */
  weight: number
  l: number
  c: number
  h: number
}

const IMAGE_CLUSTERS = 6
const IMAGE_ITERATIONS = 10
/** Pixels sampled at most; larger inputs are strided. */
const IMAGE_SAMPLE_LIMIT = 4096

/**
 * k-means in OKLab over RGBA pixels. Pixels under half alpha are skipped.
 * Seeds are spread across the lightness-sorted sample, so the result is
 * deterministic for a given input. Swatches are sorted by weight, largest
 * first.
 */
export function extractImageSwatches(rgba: Uint8ClampedArray | number[]): ImageSwatch[] {
  const total = Math.floor(rgba.length / 4)
  const stride = Math.max(1, Math.floor(total / IMAGE_SAMPLE_LIMIT))
  const pts: { l: number; a: number; b: number }[] = []
  for (let i = 0; i < total; i += stride) {
    const o = i * 4
    if (rgba[o + 3] < 128) continue
    const { l, c, h } = rgbToOklch(rgba[o], rgba[o + 1], rgba[o + 2])
    const rad = (h * Math.PI) / 180
    pts.push({ l, a: c * Math.cos(rad) * 100, b: c * Math.sin(rad) * 100 })
  }
  if (!pts.length) return []

  const sorted = [...pts].sort((p, q) => p.l - q.l)
  const k = Math.min(IMAGE_CLUSTERS, pts.length)
  let centers = Array.from({ length: k }, (_, i) => ({ ...sorted[Math.floor(((i + 0.5) / k) * sorted.length)] }))
  let assign = new Array<number>(pts.length).fill(0)

  for (let iter = 0; iter < IMAGE_ITERATIONS; iter++) {
    assign = pts.map((p) => {
      let best = 0
      let bestD = Infinity
      centers.forEach((c, ci) => {
        const d = (p.l - c.l) ** 2 + (p.a - c.a) ** 2 + (p.b - c.b) ** 2
        if (d < bestD) {
          bestD = d
          best = ci
        }
      })
      return best
    })
    centers = centers.map((c, ci) => {
      let n = 0
      const sum = { l: 0, a: 0, b: 0 }
      pts.forEach((p, pi) => {
        if (assign[pi] !== ci) return
        n++
        sum.l += p.l
        sum.a += p.a
        sum.b += p.b
      })
      return n ? { l: sum.l / n, a: sum.a / n, b: sum.b / n } : c
    })
  }

  const counts = new Array<number>(k).fill(0)
  assign.forEach((ci) => counts[ci]++)
  return centers
    .map((c, ci) => {
      const chroma = Math.hypot(c.a, c.b) / 100
      const hue = wrapHue((Math.atan2(c.b, c.a) * 180) / Math.PI)
      return {
        hex: oklchToHexInGamut(c.l, chroma, hue),
        weight: counts[ci] / pts.length,
        l: c.l,
        c: chroma,
        h: hue,
      }
    })
    .filter((s) => s.weight > 0)
    .sort((p, q) => q.weight - p.weight)
}

const hueDistance = (a: number, b: number) => {
  const d = Math.abs(wrapHue(a) - wrapHue(b))
  return Math.min(d, 360 - d)
}

/** Below this chroma a swatch counts as grey and gives no usable hue. */
const IMAGE_GREY_CHROMA = 0.025

/**
 * Theme from image swatches. Background hue is the heaviest coloured swatch;
 * its chroma sets the saturation slider. Primary is the swatch with the most
 * colour (chroma weighted by the square root of its share), accent the next
 * one at least 35 degrees away, else primary + 40. Both are re-lit to the
 * mood's targets for `mode`. Null when the swatch list is empty.
 */
export function paletteFromImage(swatches: ImageSwatch[], mode: ThemeMode, mood: PaletteMood = 'balanced'): ThemeColors | null {
  if (!swatches.length) return null
  const m = PALETTE_MOODS[mood][mode]
  const coloured = swatches.filter((s) => s.c >= IMAGE_GREY_CHROMA)
  const pool = coloured.length ? coloured : swatches

  const bgSwatch = pool[0]
  const bgChroma = Math.round(Math.min(18, Math.max(-6, (bgSwatch.c - 0.03) * 120)))
  const background = composeBackgroundToneHex(bgSwatch.h, m.bgLightness, bgChroma, mode)
  const surface = primarySurfaceHex(background, mode, m.bgLightness, bgChroma)

  const ranked = [...pool].sort((p, q) => q.c * Math.sqrt(q.weight) - p.c * Math.sqrt(p.weight))
  const primarySwatch = ranked[0]
  const accentSwatch = ranked.find((s) => hueDistance(s.h, primarySwatch.h) >= 35)
  const primaryC = Math.max(primarySwatch.c, m.primaryC * 0.6)
  const primary = ensureContrast(
    oklchToHexInGamut(m.primaryL, Math.min(primaryC, m.primaryC * 1.3), primarySwatch.h),
    surface,
    PRIMARY_ON_SURFACE_MIN,
  )
  const accentHue = accentSwatch ? accentSwatch.h : wrapHue(primarySwatch.h + 40)
  const accentC = accentSwatch ? Math.max(accentSwatch.c, m.accentC * 0.6) : m.accentC
  const accent = ensureContrast(
    oklchToHexInGamut(m.accentL, Math.min(accentC, m.accentC * 1.3), accentHue),
    surface,
    PRIMARY_ON_SURFACE_MIN,
  )

  return {
    customThemeMode: mode,
    customBackgroundColor: background,
    customBackgroundLightness: m.bgLightness,
    customBackgroundChroma: bgChroma,
    customPrimaryColor: primary.toUpperCase(),
    customAccentColor: accent.toUpperCase(),
  }
}

/** Contrast of `fg` on the --background-primary the given theme colours produce. */
export function contrastOnSurface(fg: string, colors: Pick<ThemeColors, 'customThemeMode' | 'customBackgroundColor' | 'customBackgroundLightness' | 'customBackgroundChroma'>): number {
  const surface = primarySurfaceHex(
    colors.customBackgroundColor,
    colors.customThemeMode,
    colors.customBackgroundLightness,
    colors.customBackgroundChroma,
  )
  return contrastRatio(fg, surface)
}

export { PRIMARY_ON_SURFACE_MIN }
