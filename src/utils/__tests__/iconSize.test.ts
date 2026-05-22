import { describe, it, expect } from 'vitest'
import { resolveIconSize } from '../iconSize'

describe('resolveIconSize', () => {
  it('returns positive numbers unchanged', () => {
    expect(resolveIconSize(16)).toBe(16)
    expect(resolveIconSize(24)).toBe(24)
    expect(resolveIconSize(128)).toBe(128)
  })

  it('parses numeric strings', () => {
    expect(resolveIconSize('16')).toBe(16)
    expect(resolveIconSize('24')).toBe(24)
    expect(resolveIconSize('128')).toBe(128)
  })

  it('maps symbolic sizes via the same table as the generic Icon component', () => {
    expect(resolveIconSize('xs')).toBe(12)
    expect(resolveIconSize('sm')).toBe(16)
    expect(resolveIconSize('md')).toBe(20)
    expect(resolveIconSize('lg')).toBe(24)
    expect(resolveIconSize('xl')).toBe(28)
  })

  it('maps long-form symbolic aliases', () => {
    expect(resolveIconSize('small')).toBe(16)
    expect(resolveIconSize('medium')).toBe(20)
    expect(resolveIconSize('large')).toBe(24)
  })

  it('falls back to the provided default on unknown strings', () => {
    expect(resolveIconSize('huge')).toBe(20)
    expect(resolveIconSize('huge', 40)).toBe(40)
    // The bug-trigger case: previously Number('sm') was NaN and broke
    // lucide rendering; now we fall back to the default.
    expect(resolveIconSize('not-a-size', 18)).toBe(18)
  })

  it('falls back on undefined / null / non-positive values', () => {
    expect(resolveIconSize(undefined)).toBe(20)
    expect(resolveIconSize(null)).toBe(20)
    expect(resolveIconSize(0)).toBe(20)
    expect(resolveIconSize(-5)).toBe(20)
    expect(resolveIconSize(Number.NaN)).toBe(20)
  })

  it('respects the custom fallback for nullish input', () => {
    expect(resolveIconSize(undefined, 32)).toBe(32)
    expect(resolveIconSize('', 32)).toBe(32)
  })
})
