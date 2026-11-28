/**
 * Ops onto a canvas. A target canvas maps the 800 x 600 logical canvas onto its own pixels
 * (scale = canvas.width / 800). Paper is white; the eraser paints paper. Translucent strokes and
 * shapes draw opaque on a scratch layer, then composite once at their alpha, so overlapping
 * segments of one stroke do not darken.
 */

import { floodFill } from './fill'
import { LOGICAL_W, QUANT, type Op } from './ops'

export const PAPER = '#ffffff'

const scratchCanvas = (() => {
  let canvas: HTMLCanvasElement | null = null
  return (w: number, h: number) => {
    canvas ??= document.createElement('canvas')
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    return { canvas, ctx }
  }
})()

export function css(color: number): string {
  return `rgb(${(color >> 16) & 255},${(color >> 8) & 255},${color & 255})`
}

/** Line width factor of a pressure value 0..255; 128 (mouse, touch) is 1. */
export function pressureWidth(p: number): number {
  return 0.35 + (1.3 * p) / 255
}

export function clearCanvas(ctx: CanvasRenderingContext2D): void {
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.restore()
}

/** Stroke path of the first `count` points (all when omitted), in canvas pixels. */
function strokePath(ctx: CanvasRenderingContext2D, pts: number[], size: number, k: number, count = pts.length / 3): void {
  const n = Math.min(count, pts.length / 3)
  if (n <= 0) return
  const x = (i: number) => pts[i * 3] * k
  const y = (i: number) => pts[i * 3 + 1] * k
  const w = (i: number) => Math.max(0.5, size * pressureWidth(pts[i * 3 + 2]) * k * QUANT)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (n === 1) {
    ctx.beginPath()
    ctx.arc(x(0), y(0), w(0) / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  // Quadratic segments through midpoints, each with the width at its control point.
  let mx = x(0)
  let my = y(0)
  for (let i = 1; i < n; i++) {
    const nx = i + 1 < n ? (x(i) + x(i + 1)) / 2 : x(i)
    const ny = i + 1 < n ? (y(i) + y(i + 1)) / 2 : y(i)
    ctx.beginPath()
    ctx.lineWidth = w(i)
    ctx.moveTo(mx, my)
    ctx.quadraticCurveTo(x(i), y(i), nx, ny)
    ctx.stroke()
    mx = nx
    my = ny
  }
}

function shapePath(ctx: CanvasRenderingContext2D, op: Extract<Op, { k: 'line' | 'rect' | 'ellipse' }>, k: number): void {
  const x0 = op.x0 * k
  const y0 = op.y0 * k
  const x1 = op.x1 * k
  const y1 = op.y1 * k
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(0.5, op.size * QUANT * k)
  ctx.beginPath()
  if (op.k === 'line') {
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
  } else if (op.k === 'rect') {
    ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
  } else {
    ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2)
  }
  ctx.stroke()
}

/**
 * Draws `op` on `ctx`. `count` limits a stroke to its first points, for the timelapse.
 * Coordinates scale by k = canvas.width / (800 * QUANT).
 */
export function drawOp(ctx: CanvasRenderingContext2D, op: Op, count?: number): void {
  const { width, height } = ctx.canvas
  const k = width / (LOGICAL_W * QUANT)
  switch (op.k) {
    case 'clear':
      clearCanvas(ctx)
      return
    case 'fill': {
      const image = ctx.getImageData(0, 0, width, height)
      floodFill(image.data, width, height, op.x * k, op.y * k, [(op.color >> 16) & 255, (op.color >> 8) & 255, op.color & 255, Math.round((op.alpha / 100) * 255)])
      ctx.putImageData(image, 0, 0)
      return
    }
    case 'erase':
      ctx.save()
      ctx.globalAlpha = 1
      ctx.strokeStyle = ctx.fillStyle = PAPER
      strokePath(ctx, op.pts, op.size, k, count)
      ctx.restore()
      return
    case 'stroke':
    case 'line':
    case 'rect':
    case 'ellipse': {
      const alpha = op.alpha / 100
      const target = alpha >= 1 ? ctx : scratchCanvas(width, height).ctx
      target.save()
      target.globalAlpha = 1
      target.strokeStyle = target.fillStyle = css(op.color)
      if (op.k === 'stroke') strokePath(target, op.pts, op.size, k, count)
      else shapePath(target, op, k)
      target.restore()
      if (target !== ctx) {
        ctx.save()
        ctx.globalAlpha = alpha
        ctx.drawImage(target.canvas, 0, 0)
        ctx.restore()
      }
    }
  }
}

export function drawOps(ctx: CanvasRenderingContext2D, ops: Op[]): void {
  clearCanvas(ctx)
  for (const op of ops) drawOp(ctx, op)
}

/** Timelapse units of an op: a stroke's points, a fixed weight for everything else. */
function units(op: Op): number {
  return op.k === 'stroke' || op.k === 'erase' ? Math.max(1, op.pts.length / 3) : 12
}

/**
 * Replays ops onto `canvas` over `durationMs`. Finished ops accumulate on a backing canvas; the op
 * in progress draws on top each frame.
 */
export class Replay {
  private raf = 0
  private done = 0
  private readonly total: number
  private readonly backing: HTMLCanvasElement
  private start = 0
  private stopped = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ops: Op[],
    private readonly durationMs: number,
    private readonly onDone?: () => void,
  ) {
    this.total = ops.reduce((n, op) => n + units(op), 0)
    this.backing = document.createElement('canvas')
    this.backing.width = canvas.width
    this.backing.height = canvas.height
    clearCanvas(this.backing.getContext('2d')!)
  }

  play(): void {
    this.stopped = false
    this.start = performance.now()
    const frame = (now: number) => {
      if (this.stopped) return
      const target = this.total * Math.min(1, (now - this.start) / Math.max(1, this.durationMs))
      this.render(target)
      if (target >= this.total) {
        this.stopped = true
        this.onDone?.()
        return
      }
      this.raf = requestAnimationFrame(frame)
    }
    this.raf = requestAnimationFrame(frame)
  }

  /** Jumps to the finished drawing. */
  finish(): void {
    this.stop()
    this.render(this.total)
    this.onDone?.()
  }

  stop(): void {
    this.stopped = true
    cancelAnimationFrame(this.raf)
  }

  private render(target: number): void {
    const back = this.backing.getContext('2d')!
    let used = 0
    for (let i = 0; i < this.done; i++) used += units(this.ops[i])
    while (this.done < this.ops.length && used + units(this.ops[this.done]) <= target) {
      drawOp(back, this.ops[this.done])
      used += units(this.ops[this.done])
      this.done++
    }
    const ctx = this.canvas.getContext('2d')!
    ctx.drawImage(this.backing, 0, 0)
    const current = this.ops[this.done]
    if (current && (current.k === 'stroke' || current.k === 'erase')) {
      const count = Math.floor(target - used)
      if (count > 0) drawOp(ctx, current, count)
    }
  }
}
