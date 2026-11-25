import { describe, expect, it } from 'vitest'
import { floodFill } from '../src/fill'

function canvas(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y)
      const i = (y * w + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
  return data
}

const at = (data: Uint8ClampedArray, w: number, x: number, y: number) => Array.from(data.slice((y * w + x) * 4, (y * w + x) * 4 + 4))

describe('flood fill', () => {
  // 12 x 12 white with a closed black square outline from 2 to 9.
  const W = 12
  const box = () => canvas(W, W, (x, y) => ((x === 2 || x === 9) && y >= 2 && y <= 9) || ((y === 2 || y === 9) && x >= 2 && x <= 9) ? [0, 0, 0] : [255, 255, 255])

  it('fills inside a closed outline and leaves the outside and the outline', () => {
    const data = box()
    const painted = floodFill(data, W, W, 5, 5, [255, 0, 0, 255])
    expect(painted).toBe(36)
    expect(at(data, W, 5, 5)).toEqual([255, 0, 0, 255])
    expect(at(data, W, 3, 3)).toEqual([255, 0, 0, 255])
    expect(at(data, W, 2, 5)).toEqual([0, 0, 0, 255])
    expect(at(data, W, 0, 0)).toEqual([255, 255, 255, 255])
    expect(at(data, W, 11, 11)).toEqual([255, 255, 255, 255])
  })

  it('fills the outside around the outline', () => {
    const data = box()
    floodFill(data, W, W, 0, 0, [0, 0, 255, 255])
    expect(at(data, W, 11, 0)).toEqual([0, 0, 255, 255])
    expect(at(data, W, 5, 5)).toEqual([255, 255, 255, 255])
  })

  it('covers antialiased edge pixels but not solid lines', () => {
    // Column 5 is a grey edge (150), column 6 solid black.
    const data = canvas(10, 4, (x) => (x === 5 ? [150, 150, 150] : x === 6 ? [0, 0, 0] : [255, 255, 255]))
    floodFill(data, 10, 4, 0, 0, [255, 0, 0, 255])
    expect(at(data, 10, 5, 1)).toEqual([255, 0, 0, 255])
    expect(at(data, 10, 6, 1)).toEqual([0, 0, 0, 255])
    expect(at(data, 10, 8, 1)).toEqual([255, 255, 255, 255])
  })

  it('composites a translucent fill', () => {
    const data = canvas(4, 4, () => [255, 255, 255])
    floodFill(data, 4, 4, 0, 0, [0, 0, 0, 128])
    const [r, , , a] = at(data, 4, 2, 2)
    expect(r).toBeGreaterThan(120)
    expect(r).toBeLessThan(135)
    expect(a).toBe(255)
  })

  it('does nothing outside the canvas or on the same colour', () => {
    const data = canvas(4, 4, () => [255, 0, 0])
    expect(floodFill(data, 4, 4, -1, 0, [0, 0, 0, 255])).toBe(0)
    expect(floodFill(data, 4, 4, 1, 1, [255, 0, 0, 255])).toBe(0)
  })
})
