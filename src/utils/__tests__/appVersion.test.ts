import { describe, expect, it } from 'vitest'
import { compareVersions, isNewerVersion, parseVersion } from '../appVersion'

describe('parseVersion', () => {
  it('accepts plain and v-prefixed x.y.z', () => {
    expect(parseVersion('1.6.2')).toEqual([1, 6, 2])
    expect(parseVersion('v1.6.2')).toEqual([1, 6, 2])
    expect(parseVersion('  v10.0.31 ')).toEqual([10, 0, 31])
  })

  it('drops pre-release and build suffixes', () => {
    expect(parseVersion('1.7.0-beta.1')).toEqual([1, 7, 0])
    expect(parseVersion('1.7.0+build.5')).toEqual([1, 7, 0])
  })

  it('rejects anything else', () => {
    expect(parseVersion('1.6')).toBeNull()
    expect(parseVersion('release-1.6.2')).toBeNull()
    expect(parseVersion('')).toBeNull()
    expect(parseVersion(null)).toBeNull()
    expect(parseVersion(undefined)).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders numerically per component, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.6.10', '1.6.9')).toBe(1)
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1)
    expect(compareVersions('v1.6.2', '1.6.2')).toBe(0)
  })

  it('returns null when a side does not parse', () => {
    expect(compareVersions('latest', '1.6.2')).toBeNull()
  })
})

describe('isNewerVersion', () => {
  it('is strict', () => {
    expect(isNewerVersion('v1.6.2', '1.6.1')).toBe(true)
    expect(isNewerVersion('1.6.1', '1.6.1')).toBe(false)
    expect(isNewerVersion('1.6.0', '1.6.1')).toBe(false)
  })

  it('treats a pre-release of the installed core version as not newer', () => {
    expect(isNewerVersion('1.6.1-rc.1', '1.6.1')).toBe(false)
  })

  it('is false for unparseable input', () => {
    expect(isNewerVersion('garbage', '1.6.1')).toBe(false)
    expect(isNewerVersion('1.6.2', 'garbage')).toBe(false)
  })
})
