import { describe, expect, it } from 'vitest'
import { DRAWING_MAX_BYTES, countMarks, decodeOps, decodeOpsSafe, encodeOps, encodedLength, opBytes, type Op } from '../src/ops'

const sample: Op[] = [
  { k: 'stroke', color: 0xdc2626, alpha: 100, size: 6, pts: [10, 20, 128, 14, 26, 130, 30, 40, 200, 1600, 1200, 0] },
  { k: 'erase', size: 20, pts: [800, 600, 128, 790, 610, 128] },
  { k: 'line', color: 0x111827, alpha: 50, size: 3, x0: 0, y0: 0, x1: 1600, y1: 1200 },
  { k: 'rect', color: 0x0ea5e9, alpha: 80, size: 12, x0: 100, y0: 120, x1: 400, y1: 500 },
  { k: 'ellipse', color: 0xffffff, alpha: 10, size: 1, x0: 5, y0: 5, x1: 6, y1: 7 },
  { k: 'fill', color: 0x22c55e, alpha: 100, x: 321, y: 654 },
  { k: 'clear' },
]

describe('drawing ops', () => {
  it('round-trips every op kind', () => {
    expect(decodeOps(encodeOps(sample))).toEqual(sample)
  })

  it('clamps coordinates, pressure and sizes into range', () => {
    const [op] = decodeOps(encodeOps([{ k: 'stroke', color: 0, alpha: 400, size: 0, pts: [-5, 99999, 999] }])) as Array<Extract<Op, { k: 'stroke' }>>
    expect(op.pts).toEqual([0, 1200, 255])
    expect(op.alpha).toBe(100)
    expect(op.size).toBe(1)
  })

  it('predicts its encoded length from per-op bytes', () => {
    const bytes = sample.reduce((n, op) => n + opBytes(op), 0)
    expect(Math.abs(encodedLength(bytes) - encodeOps(sample).length)).toBeLessThanOrEqual(1)
  })

  it('keeps a long stroke small', () => {
    const pts: number[] = []
    for (let i = 0; i < 1000; i++) pts.push(400 + Math.round(Math.cos(i / 20) * 300), 300 + Math.round(Math.sin(i / 20) * 200), 128)
    const text = encodeOps([{ k: 'stroke', color: 0, alpha: 100, size: 4, pts }])
    expect(text.length).toBeLessThan(5000)
  })

  it('refuses malformed and oversized input', () => {
    expect(() => decodeOps('x')).toThrow()
    expect(() => decodeOps('d1.' + 'A'.repeat(DRAWING_MAX_BYTES))).toThrow()
    expect(() => decodeOps('d1._w')).toThrow()
    expect(decodeOpsSafe('nope')).toEqual([])
  })

  it('counts marks without clears', () => {
    expect(countMarks(sample)).toBe(6)
  })
})
