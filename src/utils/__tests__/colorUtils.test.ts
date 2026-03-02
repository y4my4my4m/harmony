import { describe, it, expect } from 'vitest'
import {
  hexToRgb,
  rgbToHex,
  rgbToOklch,
  oklchToRgb,
  hexToOklch,
  oklchToHex,
  oklchToString,
  isLightColor,
  adjustLightness,
  adjustChroma,
  adjustHue,
  generateThemePalette,
  generatePreviewColors,
} from '@/utils/colorUtils'

describe('colorUtils', () => {
  describe('hexToRgb', () => {
    it('converts #ffffff to rgb(255, 255, 255)', () => {
      expect(hexToRgb('#ffffff')).toEqual({ r: 255, g: 255, b: 255 })
    })

    it('converts #000000 to rgb(0, 0, 0)', () => {
      expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 })
    })

    it('converts #ff0000 to rgb(255, 0, 0)', () => {
      expect(hexToRgb('#ff0000')).toEqual({ r: 255, g: 0, b: 0 })
    })

    it('handles hex without # prefix', () => {
      expect(hexToRgb('00ff00')).toEqual({ r: 0, g: 255, b: 0 })
    })

    it('returns null for invalid hex', () => {
      expect(hexToRgb('gggggg')).toBe(null)
      expect(hexToRgb('#fff')).toBe(null)
      expect(hexToRgb('')).toBe(null)
    })
  })

  describe('rgbToHex', () => {
    it('converts rgb(255, 255, 255) to #ffffff', () => {
      expect(rgbToHex(255, 255, 255)).toBe('#ffffff')
    })

    it('converts rgb(0, 0, 0) to #000000', () => {
      expect(rgbToHex(0, 0, 0)).toBe('#000000')
    })

    it('converts rgb(255, 0, 0) to #ff0000', () => {
      expect(rgbToHex(255, 0, 0)).toBe('#ff0000')
    })

    it('pads single-digit hex values', () => {
      expect(rgbToHex(1, 2, 3)).toBe('#010203')
    })
  })

  describe('rgb <-> oklch roundtrip', () => {
    it('roundtrips pure red', () => {
      const oklch = rgbToOklch(255, 0, 0)
      const rgb = oklchToRgb(oklch.l, oklch.c, oklch.h)
      expect(rgb.r).toBeCloseTo(255, 0)
      expect(rgb.g).toBeCloseTo(0, 0)
      expect(rgb.b).toBeCloseTo(0, 0)
    })

    it('roundtrips pure green', () => {
      const oklch = rgbToOklch(0, 255, 0)
      const rgb = oklchToRgb(oklch.l, oklch.c, oklch.h)
      expect(rgb.r).toBeCloseTo(0, 0)
      expect(rgb.g).toBeCloseTo(255, 0)
      expect(rgb.b).toBeCloseTo(0, 0)
    })

    it('roundtrips white', () => {
      const oklch = rgbToOklch(255, 255, 255)
      const rgb = oklchToRgb(oklch.l, oklch.c, oklch.h)
      expect(rgb.r).toBeCloseTo(255, 0)
      expect(rgb.g).toBeCloseTo(255, 0)
      expect(rgb.b).toBeCloseTo(255, 0)
    })
  })

  describe('hexToOklch and oklchToHex', () => {
    it('returns null for invalid hex', () => {
      expect(hexToOklch('invalid')).toBe(null)
    })

    it('roundtrips a color reasonably', () => {
      const oklch = hexToOklch('#3366cc')
      expect(oklch).not.toBe(null)
      const hex = oklchToHex(oklch!.l, oklch!.c, oklch!.h)
      // Allow small rounding differences
      const rgb1 = hexToRgb('#3366cc')!
      const rgb2 = hexToRgb(hex)!
      expect(Math.abs(rgb1.r - rgb2.r)).toBeLessThanOrEqual(2)
      expect(Math.abs(rgb1.g - rgb2.g)).toBeLessThanOrEqual(2)
      expect(Math.abs(rgb1.b - rgb2.b)).toBeLessThanOrEqual(2)
    })
  })

  describe('oklchToString', () => {
    it('formats OKLCH as CSS string', () => {
      const result = oklchToString(50, 0.123, 180.5)
      expect(result).toBe('oklch(50.00% 0.123 180.5)')
    })
  })

  describe('isLightColor', () => {
    it('detects white as light', () => {
      expect(isLightColor('#ffffff')).toBe(true)
    })

    it('detects black as dark', () => {
      expect(isLightColor('#000000')).toBe(false)
    })

    it('detects bright yellow as light', () => {
      expect(isLightColor('#ffff00')).toBe(true)
    })

    it('detects dark blue as dark', () => {
      expect(isLightColor('#000066')).toBe(false)
    })

    it('returns false for invalid hex', () => {
      expect(isLightColor('invalid')).toBe(false)
    })
  })

  describe('adjustLightness', () => {
    it('returns same color when delta is 0', () => {
      const original = '#3366cc'
      const adjusted = adjustLightness(original, 0)
      const rgb1 = hexToRgb(original)!
      const rgb2 = hexToRgb(adjusted)!
      expect(Math.abs(rgb1.r - rgb2.r)).toBeLessThanOrEqual(1)
    })

    it('makes color lighter with positive delta', () => {
      const oklchOriginal = hexToOklch('#3366cc')!
      const adjusted = adjustLightness('#3366cc', 20)
      const oklchNew = hexToOklch(adjusted)!
      expect(oklchNew.l).toBeGreaterThan(oklchOriginal.l)
    })

    it('makes color darker with negative delta', () => {
      const oklchOriginal = hexToOklch('#3366cc')!
      const adjusted = adjustLightness('#3366cc', -20)
      const oklchNew = hexToOklch(adjusted)!
      expect(oklchNew.l).toBeLessThan(oklchOriginal.l)
    })

    it('returns original for invalid hex', () => {
      expect(adjustLightness('invalid', 10)).toBe('invalid')
    })
  })

  describe('adjustChroma', () => {
    it('returns original for invalid hex', () => {
      expect(adjustChroma('invalid', 0.1)).toBe('invalid')
    })
  })

  describe('adjustHue', () => {
    it('returns original for invalid hex', () => {
      expect(adjustHue('invalid', 90)).toBe('invalid')
    })
  })

  describe('generateThemePalette', () => {
    it('generates a dark theme palette for dark accent color', () => {
      const palette = generateThemePalette('#1a1a2e', 'dark')
      expect(palette.isLightTheme).toBe(false)
      expect(palette.primary).toBe('#1a1a2e')
      expect(palette.textPrimary).toBe('#f2f3f5')
    })

    it('generates a light theme palette when forced', () => {
      const palette = generateThemePalette('#1a1a2e', 'light')
      expect(palette.isLightTheme).toBe(true)
      expect(palette.textPrimary).toBe('#1a1c1e')
    })

    it('uses primaryHex when provided', () => {
      const palette = generateThemePalette('#1a1a2e', 'dark', undefined, 0, '#ff0000')
      expect(palette.primary).toBe('#ff0000')
    })

    it('throws for invalid accent color', () => {
      expect(() => generateThemePalette('invalid', 'dark')).toThrow('Invalid accent color')
    })

    it('includes all required palette keys', () => {
      const palette = generateThemePalette('#3366cc', 'dark')
      const requiredKeys = [
        'primary', 'primaryHover', 'primaryLight', 'primaryDark',
        'bgPrimary', 'bgSecondary', 'bgTertiary', 'bgChat', 'bgSidebar',
        'textPrimary', 'textSecondary', 'textTertiary',
        'borderPrimary', 'borderSecondary', 'isLightTheme',
      ]
      for (const key of requiredKeys) {
        expect(palette).toHaveProperty(key)
      }
    })
  })

  describe('generatePreviewColors', () => {
    it('returns default colors for invalid hex', () => {
      const colors = generatePreviewColors('invalid', 'dark')
      expect(colors.bgMain).toBe('#313338')
    })

    it('generates colors for valid hex in dark mode', () => {
      const colors = generatePreviewColors('#3366cc', 'dark')
      expect(colors.bgMain).toBeTruthy()
      expect(colors.bgSidebar).toBeTruthy()
      expect(colors.bgHeader).toBeTruthy()
    })

    it('generates colors for valid hex in light mode', () => {
      const colors = generatePreviewColors('#3366cc', 'light')
      expect(colors.bgMain).toBeTruthy()
    })
  })
})
