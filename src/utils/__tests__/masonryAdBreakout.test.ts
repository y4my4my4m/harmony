import { describe, expect, it } from 'vitest'
import { masonryAdBreakoutStyle, masonryColumnCount } from '../masonryAdBreakout'

describe('masonryColumnCount', () => {
  it('matches two columns in the ~400px picker', () => {
    expect(masonryColumnCount(384)).toBe(2)
  })
})

describe('masonryAdBreakoutStyle', () => {
  it('spans both columns from column 0', () => {
    expect(masonryAdBreakoutStyle(0, 2, 10)).toEqual({
      width: 'calc(2 * 100% + 10px)',
      marginLeft: 'calc(-0 * (100% + 10px))',
    })
  })

  it('spans both columns from column 1', () => {
    expect(masonryAdBreakoutStyle(1, 2, 10)).toEqual({
      width: 'calc(2 * 100% + 10px)',
      marginLeft: 'calc(-1 * (100% + 10px))',
    })
  })
})
