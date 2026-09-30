import { describe, it, expect } from 'vitest'
import {
  parseCssColor,
  toHexAlpha,
  formatHexAlpha,
  resolveCssColor,
} from '@/utils/cssColor'

const hexOf = (value: string) => {
  const c = parseCssColor(value)
  return c ? toHexAlpha(c) : null
}

describe('parseCssColor', () => {
  it('parses hex in all four lengths', () => {
    expect(parseCssColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 })
    expect(parseCssColor('#abc8')).toEqual({ r: 170, g: 187, b: 204, a: 136 / 255 })
    expect(parseCssColor('#1A1A1E')).toEqual({ r: 26, g: 26, b: 30, a: 1 })
    expect(parseCssColor('#1a1a1eaa')).toEqual({ r: 26, g: 26, b: 30, a: 170 / 255 })
  })

  it('parses legacy and modern rgb syntax', () => {
    expect(parseCssColor('rgb(14, 165, 233)')).toEqual({ r: 14, g: 165, b: 233, a: 1 })
    expect(parseCssColor('rgba(255, 255, 255, 0.12)')).toEqual({ r: 255, g: 255, b: 255, a: 0.12 })
    expect(parseCssColor('rgb(0 0 0 / 50%)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 })
    expect(parseCssColor('rgb(100% 0% 50%)')).toEqual({ r: 255, g: 0, b: 128, a: 1 })
  })

  it('parses hsl', () => {
    expect(hexOf('hsl(0, 100%, 50%)')).toEqual({ hex: '#ff0000', alpha: 1 })
    expect(hexOf('hsl(120deg 100% 25% / 0.5)')).toEqual({ hex: '#008000', alpha: 0.5 })
    expect(hexOf('hsla(0.5turn, 100%, 50%, 1)')).toEqual({ hex: '#00ffff', alpha: 1 })
  })

  it('parses oklch as written by applyThemePalette and as serialized by getComputedStyle', () => {
    const written = parseCssColor('oklch(17.40% 0.016 238.0)')
    const computed = parseCssColor('oklch(0.174 0.016 238)')
    expect(written).not.toBeNull()
    expect(written).toEqual(computed)
    const alpha = parseCssColor('oklch(16.83% 0.015 239.8 / 0.67)')
    expect(alpha?.a).toBeCloseTo(0.67)
    expect(hexOf('oklch(100% 0 0)')).toEqual({ hex: '#ffffff', alpha: 1 })
    expect(hexOf('oklch(0% 0 0)')).toEqual({ hex: '#000000', alpha: 1 })
  })

  it('parses oklab and color(srgb) as serialized for color-mix results', () => {
    expect(hexOf('oklab(1 0 0)')).toEqual({ hex: '#ffffff', alpha: 1 })
    expect(parseCssColor('color(srgb 0.0549 0.647 0.914 / 0.15)')).toEqual({ r: 14, g: 165, b: 233, a: 0.15 })
    expect(parseCssColor('color(srgb-linear 1 0 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
  })

  it('treats transparent as zero alpha', () => {
    expect(parseCssColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
  })

  it('returns null for values the browser must resolve or that are not colours', () => {
    for (const v of ['', 'red', 'var(--x)', 'color-mix(in srgb, red 50%, blue)', '#12', '#12345', 'rgb(1, 2)', '12px', 'oklch(50% 0.1 10px)']) {
      expect(parseCssColor(v)).toBeNull()
    }
  })

  it('clamps out-of-range channels', () => {
    expect(parseCssColor('rgb(300, -5, 128, 2)')).toEqual({ r: 255, g: 0, b: 128, a: 1 })
  })
})

describe('formatHexAlpha', () => {
  it('omits alpha when opaque', () => {
    expect(formatHexAlpha('#AABBCC', 1)).toBe('#aabbcc')
  })

  it('appends alpha as a two-digit byte', () => {
    expect(formatHexAlpha('#1a1a1e', 0.67)).toBe('#1a1a1eab')
    expect(formatHexAlpha('#000000', 0.02)).toBe('#00000005')
    expect(formatHexAlpha('#000000', 0)).toBe('#00000000')
  })

  it('round-trips through parseCssColor within 1/255', () => {
    const out = formatHexAlpha('#336699', 0.4)
    const back = toHexAlpha(parseCssColor(out)!)
    expect(back.hex).toBe('#336699')
    expect(Math.abs(back.alpha - 0.4)).toBeLessThanOrEqual(1 / 255)
  })
})

describe('resolveCssColor', () => {
  it('resolves parseable values without touching the DOM', () => {
    expect(resolveCssColor('  rgba(14, 165, 233, 0.15) ')).toEqual({ r: 14, g: 165, b: 233, a: 0.15 })
  })

  it('returns null for empty values', () => {
    expect(resolveCssColor('')).toBeNull()
    expect(resolveCssColor('   ')).toBeNull()
  })
})
