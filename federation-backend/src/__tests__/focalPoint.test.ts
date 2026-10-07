import { describe, it, expect } from 'vitest'
import { FOCAL_POINT_CONTEXT, parseFocalPoint, storedFocalPoint } from '../utils/focalPoint.js'

describe('parseFocalPoint', () => {
  it('reads [x, y] and the JSON-LD expanded list', () => {
    expect(parseFocalPoint([0.5, -0.5])).toEqual([0.5, -0.5])
    expect(parseFocalPoint({ '@list': [-0.2, 0.9] })).toEqual([-0.2, 0.9])
    expect(parseFocalPoint(['0.25', '-0.75'])).toEqual([0.25, -0.75])
  })

  it('clamps to [-1, 1] at two decimals', () => {
    expect(parseFocalPoint([1.5, -2])).toEqual([1, -1])
    expect(parseFocalPoint([0.123456, -0.98765])).toEqual([0.12, -0.99])
    expect(Object.is(parseFocalPoint([-0.001, 0])![0], 0)).toBe(true)
  })

  it('rejects anything that is not two finite numbers', () => {
    for (const bad of [null, undefined, 0, 'x', [], [1], [NaN, 1], [Infinity, 0], ['a', 'b'], { x: 1, y: 1 }, { '@list': ['a'] }]) {
      expect(parseFocalPoint(bad)).toBeNull()
    }
  })
})

describe('storedFocalPoint', () => {
  it('reads AP copies, composer meta.focus and a bare focus', () => {
    expect(storedFocalPoint({ focalPoint: [0.1, 0.2] })).toEqual([0.1, 0.2])
    expect(storedFocalPoint({ meta: { focus: { x: -0.3, y: 0.4 } } })).toEqual([-0.3, 0.4])
    expect(storedFocalPoint({ focus: { x: 1, y: -1 } })).toEqual([1, -1])
    expect(storedFocalPoint({ meta: { focus: { x: 'a', y: 0 } } })).toBeNull()
    expect(storedFocalPoint(null)).toBeNull()
  })
})

describe('FOCAL_POINT_CONTEXT', () => {
  it('matches Mastodon: an ordered list in the toot namespace', () => {
    expect(FOCAL_POINT_CONTEXT).toEqual({
      toot: 'http://joinmastodon.org/ns#',
      focalPoint: { '@container': '@list', '@id': 'toot:focalPoint' },
    })
  })
})
