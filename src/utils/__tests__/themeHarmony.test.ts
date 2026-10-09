import { describe, it, expect, vi } from 'vitest'

vi.mock('@/utils/debug', () => ({
  debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  contrastRatio,
  ensureContrast,
  generateThemePalette,
  hexToOklch,
  oklchToHexInGamut,
  primarySurfaceHex,
  readableTextOn,
} from '../colorUtils'
import {
  HARMONY_SCHEMES,
  PALETTE_MOODS,
  PRIMARY_ON_SURFACE_MIN,
  contrastOnSurface,
  extractImageSwatches,
  paletteFromImage,
  randomPalette,
  suggestPalettes,
  type PaletteMood,
} from '../themeHarmony'

const hueDistance = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d)
}

function seeded(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

describe('contrast helpers', () => {
  it('computes WCAG ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    expect(contrastRatio('bogus', '#ffffff')).toBe(1)
  })

  it('keeps white labels on the default primary and dark ones on pale fills', () => {
    expect(readableTextOn('#0EA5E9')).toBe('#ffffff')
    expect(readableTextOn('#DC143C')).toBe('#ffffff')
    const onYellow = readableTextOn('#FACC15')
    expect(onYellow).not.toBe('#ffffff')
    expect(contrastRatio('#FACC15', onYellow)).toBeGreaterThan(7)
  })

  it('moves a colour away from the background until it passes', () => {
    const bg = '#1a1a1e'
    const fixed = ensureContrast('#2a2a60', bg, 3)
    expect(contrastRatio(fixed, bg)).toBeGreaterThanOrEqual(3)
    expect(hueDistance(hexToOklch(fixed)!.h, hexToOklch('#2a2a60')!.h)).toBeLessThan(6)
    expect(ensureContrast('#ffffff', bg, 3)).toBe('#ffffff')
  })

  it('reduces chroma instead of clipping out-of-gamut colours', () => {
    const hex = oklchToHexInGamut(90, 0.3, 100)
    const back = hexToOklch(hex)!
    expect(back.l).toBeGreaterThan(88)
    expect(back.l).toBeLessThan(92)
    expect(hueDistance(back.h, 100)).toBeLessThan(4)
  })
})

describe('text tiers', () => {
  it('stay neutral at the default saturation', () => {
    const p = generateThemePalette('#0EA5E9', 'dark', '#6b3559', 0, '#0EA5E9', 0)
    expect(p.textPrimary).toBe('#f2f3f5')
    expect(p.textTertiary).toBe('#80848e')
  })

  it('take the background hue once saturation is raised, keeping lightness', () => {
    const p = generateThemePalette('#0EA5E9', 'dark', '#6b3559', 0, '#0EA5E9', 20)
    const bgHue = hexToOklch('#6b3559')!.h
    const tertiary = hexToOklch(p.textTertiary)!
    expect(p.textTertiary).not.toBe('#80848e')
    expect(hueDistance(tertiary.h, bgHue)).toBeLessThan(10)
    expect(Math.abs(tertiary.l - hexToOklch('#80848e')!.l)).toBeLessThan(1.5)
  })
})

describe('suggestPalettes', () => {
  const moods = Object.keys(PALETTE_MOODS) as PaletteMood[]

  it('returns one suggestion per scheme with the seed hue on primary', () => {
    const list = suggestPalettes('#e11d48', 'dark', 'balanced')
    expect(list.map((s) => s.label)).toEqual(Object.values(HARMONY_SCHEMES).map((s) => s.label))
    const seedHue = hexToOklch('#e11d48')!.h
    for (const s of list) {
      expect(hueDistance(hexToOklch(s.colors.customPrimaryColor)!.h, seedHue)).toBeLessThan(8)
    }
  })

  it('keeps primary and accent legible on the surface for every mood and mode', () => {
    for (const mode of ['dark', 'light'] as const) {
      for (const mood of moods) {
        for (const seed of ['#0ea5e9', '#facc15', '#22c55e', '#a855f7', '#f97316']) {
          for (const s of suggestPalettes(seed, mode, mood)) {
            expect(contrastOnSurface(s.colors.customPrimaryColor, s.colors)).toBeGreaterThanOrEqual(PRIMARY_ON_SURFACE_MIN - 0.05)
            expect(contrastOnSurface(s.colors.customAccentColor, s.colors)).toBeGreaterThanOrEqual(PRIMARY_ON_SURFACE_MIN - 0.05)
          }
        }
      }
    }
  })

  it('places the complement accent opposite the seed', () => {
    const complement = suggestPalettes('#0ea5e9', 'dark', 'vivid').find((s) => s.label === 'Complement')!
    const d = hueDistance(hexToOklch(complement.colors.customAccentColor)!.h, hexToOklch('#0ea5e9')!.h)
    expect(d).toBeGreaterThan(150)
  })

  it('returns nothing for an invalid seed', () => {
    expect(suggestPalettes('nope', 'dark', 'soft')).toEqual([])
  })

  it('writes a background tone the surface derivation accepts', () => {
    for (const s of suggestPalettes('#14b8a6', 'light', 'soft')) {
      const surface = primarySurfaceHex(
        s.colors.customBackgroundColor,
        'light',
        s.colors.customBackgroundLightness,
        s.colors.customBackgroundChroma,
      )
      expect(hexToOklch(surface)!.l).toBeGreaterThan(90)
    }
  })
})

describe('randomPalette', () => {
  it('is deterministic for a seeded generator and respects the mode', () => {
    const a = randomPalette('light', seeded(7))
    const b = randomPalette('light', seeded(7))
    expect(a).toEqual(b)
    expect(a.colors.customThemeMode).toBe('light')
  })
})

describe('image palettes', () => {
  function pixels(colors: [number, number, number, number][]): number[] {
    return colors.flat()
  }

  it('clusters pixels and orders swatches by share', () => {
    const navy = Array.from({ length: 70 }, () => [20, 30, 80, 255] as [number, number, number, number])
    const orange = Array.from({ length: 25 }, () => [250, 120, 20, 255] as [number, number, number, number])
    const clear = Array.from({ length: 40 }, () => [255, 0, 255, 0] as [number, number, number, number])
    const swatches = extractImageSwatches(pixels([...navy, ...orange, ...clear]))
    expect(swatches[0].weight).toBeCloseTo(70 / 95, 2)
    expect(swatches.reduce((n, s) => n + s.weight, 0)).toBeCloseTo(1, 5)
    expect(swatches.some((s) => s.hex === '#ff00ff')).toBe(false)
  })

  it('takes the background hue from the heaviest swatch and primary from the most colourful', () => {
    const navy = Array.from({ length: 70 }, () => [20, 30, 80, 255] as [number, number, number, number])
    const orange = Array.from({ length: 25 }, () => [250, 120, 20, 255] as [number, number, number, number])
    const swatches = extractImageSwatches(pixels([...navy, ...orange]))
    const colors = paletteFromImage(swatches, 'dark')!
    const navyHue = hexToOklch('#141e50')!.h
    const orangeHue = hexToOklch('#fa7814')!.h
    expect(hueDistance(hexToOklch(colors.customBackgroundColor)!.h, navyHue)).toBeLessThan(10)
    expect(hueDistance(hexToOklch(colors.customPrimaryColor)!.h, orangeHue)).toBeLessThan(10)
    expect(contrastOnSurface(colors.customPrimaryColor, colors)).toBeGreaterThanOrEqual(PRIMARY_ON_SURFACE_MIN - 0.05)
  })

  it('returns null with no opaque pixels', () => {
    expect(paletteFromImage(extractImageSwatches(pixels([[1, 2, 3, 0]])), 'dark')).toBeNull()
  })
})
