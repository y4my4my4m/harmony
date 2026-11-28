import { describe, expect, it } from 'vitest'
import { chainOf, handler, offsets, stepCount, stepKind } from '../src/assign'

describe('assignment rotation', () => {
  for (let n = 2; n <= 16; n++) {
    it(`classic, ${n} players: every seat handles every chain once`, () => {
      const steps = stepCount(n, 'classic')
      expect(steps).toBe(n)
      const offs = offsets(n, steps, 1234 + n)
      expect(offs[0]).toBe(0)
      const handled = Array.from({ length: n }, () => new Set<number>())
      for (let s = 0; s < steps; s++) {
        const seats = new Set<number>()
        for (let c = 0; c < n; c++) {
          const seat = handler(c, s, n, offs)
          seats.add(seat)
          handled[seat].add(c)
          expect(chainOf(seat, s, n, offs)).toBe(c)
          if (s > 0) expect(seat).not.toBe(handler(c, s - 1, n, offs))
        }
        expect(seats.size).toBe(n)
      }
      for (const set of handled) expect(set.size).toBe(n)
      for (let c = 0; c < n; c++) expect(handler(c, 0, n, offs)).toBe(c)
    })

    it(`marathon, ${n} players: permutations, no repeated hands on consecutive steps`, () => {
      const steps = stepCount(n, 'marathon')
      expect(steps).toBe(Math.min(2 * n, 16))
      const offs = offsets(n, steps, 99 + n)
      for (let s = 0; s < steps; s++) {
        const seats = new Set<number>()
        for (let c = 0; c < n; c++) {
          seats.add(handler(c, s, n, offs))
          if (s > 0) expect(handler(c, s, n, offs)).not.toBe(handler(c, s - 1, n, offs))
        }
        expect(seats.size).toBe(n)
      }
    })
  }

  it('is deterministic for a seed and varies across seeds', () => {
    expect(offsets(8, 8, 42)).toEqual(offsets(8, 8, 42))
    const distinct = new Set(Array.from({ length: 20 }, (_, i) => offsets(8, 8, i).join(',')))
    expect(distinct.size).toBeGreaterThan(10)
  })

  it('does not always pass to the same neighbour', () => {
    const n = 8
    const offs = offsets(n, n, 7)
    const deltas = new Set<number>()
    for (let s = 1; s < n; s++) deltas.add((offs[s] - offs[s - 1] + n) % n)
    expect(deltas.size).toBeGreaterThan(1)
  })

  it('alternates write, draw and describe', () => {
    expect([0, 1, 2, 3, 4].map(stepKind)).toEqual(['write', 'draw', 'describe', 'draw', 'describe'])
  })
})
