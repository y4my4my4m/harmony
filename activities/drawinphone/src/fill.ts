/**
 * Scanline flood fill on RGBA pixels.
 *
 * Pixels whose largest channel difference from the seed colour is at most `tolerance` join the
 * region. The region then grows by one pixel into neighbours within EDGE_TOLERANCE of the seed
 * colour: antialiased edges of a line are covered, its solid core is not. Filled pixels are the
 * fill colour composited over what was there ("source-over"). Returns the number of pixels painted.
 */

export const DEFAULT_TOLERANCE = 48
const EDGE_TOLERANCE = 160

function distance(data: Uint8ClampedArray, i: number, r: number, g: number, b: number, a: number): number {
  return Math.max(Math.abs(data[i] - r), Math.abs(data[i + 1] - g), Math.abs(data[i + 2] - b), Math.abs(data[i + 3] - a))
}

export function floodFill(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  sx: number,
  sy: number,
  fill: [number, number, number, number],
  tolerance = DEFAULT_TOLERANCE,
): number {
  sx = Math.floor(sx)
  sy = Math.floor(sy)
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return 0
  const seed = (sy * width + sx) * 4
  const tr = data[seed]
  const tg = data[seed + 1]
  const tb = data[seed + 2]
  const ta = data[seed + 3]
  const [fr, fg, fb, fa] = fill
  if (fa === 255 && distance(data, seed, fr, fg, fb, fa) === 0) return 0

  const mask = new Uint8Array(width * height)
  const inside = (p: number) => mask[p] === 0 && distance(data, p * 4, tr, tg, tb, ta) <= tolerance
  const stack: number[] = [sx, sy]
  while (stack.length) {
    const y = stack.pop()!
    let x = stack.pop()!
    let p = y * width + x
    while (x > 0 && inside(p - 1)) {
      x--
      p--
    }
    let upOpen = false
    let downOpen = false
    while (x < width && inside(p)) {
      mask[p] = 1
      if (y > 0) {
        const up = inside(p - width)
        if (up && !upOpen) stack.push(x, y - 1)
        upOpen = up
      }
      if (y < height - 1) {
        const down = inside(p + width)
        if (down && !downOpen) stack.push(x, y + 1)
        downOpen = down
      }
      x++
      p++
    }
  }

  // One pixel into antialiased edges.
  const grown = mask.slice()
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (mask[p]) continue
      const touches = (x > 0 && mask[p - 1]) || (x < width - 1 && mask[p + 1]) || (y > 0 && mask[p - width]) || (y < height - 1 && mask[p + width])
      if (touches && distance(data, p * 4, tr, tg, tb, ta) <= EDGE_TOLERANCE) grown[p] = 1
    }
  }

  const alpha = fa / 255
  let painted = 0
  for (let p = 0; p < grown.length; p++) {
    if (!grown[p]) continue
    const i = p * 4
    if (alpha >= 1) {
      data[i] = fr
      data[i + 1] = fg
      data[i + 2] = fb
      data[i + 3] = 255
    } else {
      const da = data[i + 3] / 255
      const oa = alpha + da * (1 - alpha)
      data[i] = Math.round((fr * alpha + data[i] * da * (1 - alpha)) / (oa || 1))
      data[i + 1] = Math.round((fg * alpha + data[i + 1] * da * (1 - alpha)) / (oa || 1))
      data[i + 2] = Math.round((fb * alpha + data[i + 2] * da * (1 - alpha)) / (oa || 1))
      data[i + 3] = Math.round(oa * 255)
    }
    painted++
  }
  return painted
}
