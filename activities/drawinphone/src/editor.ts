/**
 * Drawing editor. The paper is a fixed WORK_W x WORK_H canvas scaled by CSS to fit; committed ops
 * render there. The op in progress previews on an overlay canvas whose CSS opacity is the op's alpha.
 * Undo and redo replay from the nearest checkpoint, an ImageData taken every CHECKPOINT_EVERY ops
 * (at most MAX_CHECKPOINTS kept).
 */

import { h, icon, ICONS } from './dom'
import type { Key } from './i18n'
import { DRAWING_MAX_BYTES, LOGICAL_H, LOGICAL_W, QUANT, decodeOpsSafe, encodeOps, encodedLength, hexToRgb, opBytes, rgbToHex, type Op, type ShapeKind } from './ops'
import { clearCanvas, css, drawOp } from './render'

export const WORK_W = 1200
export const WORK_H = 900
const CHECKPOINT_EVERY = 24
const MAX_CHECKPOINTS = 3
const MAX_POINTS = 6000
/** Minimum distance between recorded points, quantized units. */
const MIN_STEP = 3
const SMOOTHING = 0.45

export type Tool = 'brush' | 'eraser' | 'fill' | 'line' | 'rect' | 'ellipse' | 'picker'
export const TOOLS: Tool[] = ['brush', 'eraser', 'fill', 'line', 'rect', 'ellipse', 'picker']
const TOOL_KEYS: Record<string, Tool> = { b: 'brush', e: 'eraser', f: 'fill', l: 'line', r: 'rect', o: 'ellipse', i: 'picker' }

export const PALETTE = [
  0x111827, 0x4b5563, 0x9ca3af, 0xffffff, 0x7f1d1d, 0xdc2626, 0xf87171, 0xfecaca,
  0xc2410c, 0xf97316, 0xfacc15, 0xfef08a, 0x166534, 0x22c55e, 0x86efac, 0x0e7490,
  0x0ea5e9, 0x1d4ed8, 0x93c5fd, 0x6d28d9, 0xa855f7, 0xdb2777, 0xf9a8d4, 0x92400e,
]

const SIZES = [3, 6, 12, 20, 36]

type T = (key: Key, vars?: Record<string, string | number>) => string

export class Editor {
  readonly el: HTMLElement
  private ops: Op[] = []
  private redoStack: Op[] = []
  private bytes = 0
  private checkpoints: Array<{ at: number; image: ImageData }> = []
  private readonly paper: HTMLCanvasElement
  private readonly overlay: HTMLCanvasElement
  private readonly pctx: CanvasRenderingContext2D
  private readonly octx: CanvasRenderingContext2D
  private tool: Tool = 'brush'
  private color = PALETTE[0]
  private size = 6
  private alpha = 100
  private live: { op: Op; pointer: number; last: [number, number] } | null = null
  private enabled = true
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>()
  private readonly swatches: HTMLButtonElement[] = []
  private readonly custom: HTMLInputElement
  private readonly sizeInput: HTMLInputElement
  private readonly alphaInput: HTMLInputElement
  private readonly undoButton: HTMLButtonElement
  private readonly redoButton: HTMLButtonElement
  private readonly sizeDot: HTMLElement
  private readonly onKey = (e: KeyboardEvent) => this.key(e)

  constructor(private readonly t: T, private readonly onToast: (text: string) => void) {
    this.paper = h('canvas', { class: 'paper', width: WORK_W, height: WORK_H, 'aria-hidden': 'true' })
    this.overlay = h('canvas', { class: 'overlay', width: WORK_W, height: WORK_H, testid: 'dp-canvas', role: 'img', 'aria-label': t('canvasLabel'), tabindex: 0 })
    this.pctx = this.paper.getContext('2d', { willReadFrequently: true })!
    this.octx = this.overlay.getContext('2d')!
    clearCanvas(this.pctx)

    const toolRow = h('div', { class: 'tools', role: 'toolbar', 'aria-label': t('tool_brush') })
    for (const tool of TOOLS) {
      const button = h('button', {
        type: 'button',
        class: 'tool',
        testid: `dp-tool-${tool}`,
        'aria-label': t(`tool_${tool}` as Key),
        title: `${t(`tool_${tool}` as Key)} (${Object.entries(TOOL_KEYS).find(([, v]) => v === tool)![0].toUpperCase()})`,
        'aria-pressed': 'false',
        onclick: () => this.setTool(tool),
      }, icon([...ICONS[tool]]))
      this.toolButtons.set(tool, button)
      toolRow.appendChild(button)
    }

    this.sizeDot = h('span', { class: 'size-dot', 'aria-hidden': 'true' })
    this.sizeInput = h('input', { type: 'range', min: 1, max: 60, value: this.size, 'aria-label': t('size'), oninput: () => this.setSize(Number(this.sizeInput.value)) })
    this.alphaInput = h('input', { type: 'range', min: 10, max: 100, step: 5, value: this.alpha, 'aria-label': t('opacity'), oninput: () => { this.alpha = Number(this.alphaInput.value); this.refreshDot() } })
    const sizePresets = h('div', { class: 'size-presets' },
      ...SIZES.map((s) => h('button', { type: 'button', class: 'size-preset', 'aria-label': `${t('size')} ${s}`, onclick: () => this.setSize(s) }, h('span', { style: `width:${Math.min(22, 3 + s * 0.55)}px;height:${Math.min(22, 3 + s * 0.55)}px` }))))

    const palette = h('div', { class: 'palette', role: 'group', 'aria-label': t('color', { n: '' }).trim() })
    PALETTE.forEach((color, i) => {
      const swatch = h('button', {
        type: 'button',
        class: 'swatch',
        style: `--c:${css(color)}`,
        testid: `dp-color-${i}`,
        'aria-label': t('color', { n: i + 1 }),
        'aria-pressed': 'false',
        onclick: () => this.setColor(color),
      })
      this.swatches.push(swatch)
      palette.appendChild(swatch)
    })
    this.custom = h('input', { type: 'color', class: 'custom-color', value: rgbToHex(this.color), 'aria-label': t('customColor'), oninput: () => this.setColor(hexToRgb(this.custom.value)) })
    palette.appendChild(h('label', { class: 'swatch swatch--custom', title: t('customColor') }, this.custom))

    this.undoButton = h('button', { type: 'button', class: 'tool', testid: 'dp-undo', 'aria-label': t('undo'), title: `${t('undo')} (Ctrl+Z)`, onclick: () => this.undo() }, icon([...ICONS.undo]))
    this.redoButton = h('button', { type: 'button', class: 'tool', testid: 'dp-redo', 'aria-label': t('redo'), title: `${t('redo')} (Ctrl+Shift+Z)`, onclick: () => this.redo() }, icon([...ICONS.redo]))
    const clearButton = h('button', { type: 'button', class: 'tool', testid: 'dp-clear', 'aria-label': t('clear'), title: t('clear'), onclick: () => this.commit({ k: 'clear' }) }, icon([...ICONS.trash]))

    const stage = h('div', { class: 'stage' }, h('div', { class: 'sheet' }, this.paper, this.overlay))
    this.el = h('div', { class: 'editor' },
      h('div', { class: 'editor-side' }, toolRow, h('div', { class: 'history' }, this.undoButton, this.redoButton, clearButton)),
      stage,
      h('div', { class: 'editor-props' },
        palette,
        h('div', { class: 'sliders' },
          h('label', { class: 'slider' }, this.sizeDot, this.sizeInput),
          sizePresets,
          h('label', { class: 'slider slider--alpha' }, h('span', { class: 'alpha-icon', 'aria-hidden': 'true' }), this.alphaInput))))

    this.overlay.addEventListener('pointerdown', (e) => this.down(e))
    this.overlay.addEventListener('pointermove', (e) => this.move(e))
    this.overlay.addEventListener('pointerup', (e) => this.up(e))
    this.overlay.addEventListener('pointercancel', (e) => this.up(e))
    this.overlay.addEventListener('contextmenu', (e) => e.preventDefault())
    document.addEventListener('keydown', this.onKey)

    this.setTool('brush')
    this.setColor(this.color)
    this.refreshHistory()
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKey)
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.el.classList.toggle('is-disabled', !on)
    if (!on) this.cancelLive()
  }

  isEmpty(): boolean {
    return !this.ops.some((op) => op.k !== 'clear')
  }

  encoded(): string {
    return encodeOps(this.ops)
  }

  /** Replaces the drawing (a returned answer to change). */
  load(encoded: string): void {
    this.ops = decodeOpsSafe(encoded)
    this.redoStack = []
    this.bytes = this.ops.reduce((n, op) => n + opBytes(op), 0)
    this.checkpoints = []
    this.repaint()
  }

  /* ---------------------------------------------------------------------------------------------- */

  private setTool(tool: Tool): void {
    this.tool = tool
    for (const [name, button] of this.toolButtons) button.setAttribute('aria-pressed', String(name === tool))
    this.overlay.dataset.tool = tool
  }

  private setColor(color: number): void {
    this.color = color
    this.swatches.forEach((s, i) => s.setAttribute('aria-pressed', String(PALETTE[i] === color)))
    this.custom.value = rgbToHex(color)
    this.el.style.setProperty('--ink', css(color))
    if (this.tool === 'eraser' || this.tool === 'picker') this.setTool('brush')
    this.refreshDot()
  }

  private setSize(size: number): void {
    this.size = Math.max(1, Math.min(60, Math.round(size)))
    this.sizeInput.value = String(this.size)
    this.refreshDot()
  }

  private refreshDot(): void {
    const px = Math.max(4, Math.min(28, this.size * 0.6 + 3))
    this.sizeDot.style.width = this.sizeDot.style.height = `${px}px`
    this.sizeDot.style.opacity = String(this.alpha / 100)
  }

  private refreshHistory(): void {
    this.undoButton.disabled = this.ops.length === 0
    this.redoButton.disabled = this.redoStack.length === 0
  }

  /** Quantized logical coordinates of a pointer event. */
  private point(e: PointerEvent): [number, number] {
    const rect = this.overlay.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * LOGICAL_W * QUANT
    const y = ((e.clientY - rect.top) / rect.height) * LOGICAL_H * QUANT
    return [Math.max(0, Math.min(LOGICAL_W * QUANT, x)), Math.max(0, Math.min(LOGICAL_H * QUANT, y))]
  }

  private pressure(e: PointerEvent): number {
    return e.pointerType === 'pen' && e.pressure > 0 ? Math.round(e.pressure * 255) : 128
  }

  private down(e: PointerEvent): void {
    if (!this.enabled || this.live || (e.pointerType === 'mouse' && e.button !== 0)) return
    e.preventDefault()
    this.overlay.setPointerCapture?.(e.pointerId)
    const [x, y] = this.point(e)
    switch (this.tool) {
      case 'fill':
        this.commit({ k: 'fill', color: this.color, alpha: this.alpha, x: Math.round(x), y: Math.round(y) })
        return
      case 'picker': {
        const k = WORK_W / (LOGICAL_W * QUANT)
        const px = this.pctx.getImageData(Math.min(WORK_W - 1, Math.floor(x * k)), Math.min(WORK_H - 1, Math.floor(y * k)), 1, 1).data
        this.setColor((px[0] << 16) | (px[1] << 8) | px[2])
        return
      }
      case 'brush':
      case 'eraser': {
        const p = this.pressure(e)
        const op: Op = this.tool === 'eraser'
          ? { k: 'erase', size: this.size, pts: [x, y, p] }
          : { k: 'stroke', color: this.color, alpha: this.alpha, size: this.size, pts: [x, y, p] }
        this.live = { op, pointer: e.pointerId, last: [x, y] }
        break
      }
      default:
        this.live = {
          op: { k: this.tool as ShapeKind, color: this.color, alpha: this.alpha, size: this.size, x0: x, y0: y, x1: x, y1: y },
          pointer: e.pointerId,
          last: [x, y],
        }
    }
    this.drawLive()
  }

  private move(e: PointerEvent): void {
    const live = this.live
    if (!live || e.pointerId !== live.pointer) return
    e.preventDefault()
    const op = live.op
    if (op.k === 'stroke' || op.k === 'erase') {
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e]
      for (const ev of events.length ? events : [e]) {
        if (op.pts.length / 3 >= MAX_POINTS) break
        const [rx, ry] = this.point(ev)
        const sx = live.last[0] + (rx - live.last[0]) * (1 - SMOOTHING)
        const sy = live.last[1] + (ry - live.last[1]) * (1 - SMOOTHING)
        const n = op.pts.length
        if (Math.hypot(sx - op.pts[n - 3], sy - op.pts[n - 2]) < MIN_STEP) continue
        op.pts.push(sx, sy, this.pressure(ev))
        live.last = [sx, sy]
      }
    } else if (op.k === 'line' || op.k === 'rect' || op.k === 'ellipse') {
      let [x, y] = this.point(e)
      if (e.shiftKey) {
        const dx = x - op.x0
        const dy = y - op.y0
        if (op.k === 'line') {
          const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
          const len = Math.hypot(dx, dy)
          x = op.x0 + Math.cos(angle) * len
          y = op.y0 + Math.sin(angle) * len
        } else {
          const side = Math.max(Math.abs(dx), Math.abs(dy))
          x = op.x0 + Math.sign(dx || 1) * side
          y = op.y0 + Math.sign(dy || 1) * side
        }
      }
      op.x1 = x
      op.y1 = y
    }
    this.drawLive()
  }

  private up(e: PointerEvent): void {
    const live = this.live
    if (!live || e.pointerId !== live.pointer) return
    this.live = null
    this.octx.clearRect(0, 0, WORK_W, WORK_H)
    const op = live.op
    if (op.k === 'stroke' || op.k === 'erase') {
      op.pts = op.pts.map((v, i) => (i % 3 === 2 ? v : Math.round(v)))
    } else if (op.k === 'line' || op.k === 'rect' || op.k === 'ellipse') {
      op.x0 = Math.round(op.x0)
      op.y0 = Math.round(op.y0)
      op.x1 = Math.round(op.x1)
      op.y1 = Math.round(op.y1)
      if (Math.hypot(op.x1 - op.x0, op.y1 - op.y0) < 2) return
    }
    this.commit(op)
  }

  private cancelLive(): void {
    this.live = null
    this.octx.clearRect(0, 0, WORK_W, WORK_H)
  }

  private drawLive(): void {
    const live = this.live
    this.octx.clearRect(0, 0, WORK_W, WORK_H)
    if (!live) return
    const op = live.op
    this.overlay.style.opacity = op.k === 'erase' ? '1' : String(('alpha' in op ? op.alpha : 100) / 100)
    // Opaque preview; the overlay's CSS opacity applies the alpha once.
    drawOp(this.octx, 'alpha' in op ? { ...op, alpha: 100 } as Op : op)
  }

  private commit(op: Op): void {
    const bytes = opBytes(op)
    if (encodedLength(this.bytes + bytes) > DRAWING_MAX_BYTES) {
      this.onToast(this.t('canvasFull'))
      return
    }
    this.ops.push(op)
    this.bytes += bytes
    this.redoStack = []
    drawOp(this.pctx, op)
    this.checkpoint()
    this.refreshHistory()
  }

  private checkpoint(): void {
    if (this.ops.length % CHECKPOINT_EVERY !== 0) return
    this.checkpoints.push({ at: this.ops.length, image: this.pctx.getImageData(0, 0, WORK_W, WORK_H) })
    if (this.checkpoints.length > MAX_CHECKPOINTS) this.checkpoints.shift()
  }

  private undo(): void {
    if (!this.enabled || !this.ops.length) return
    const op = this.ops.pop()!
    this.bytes -= opBytes(op)
    this.redoStack.push(op)
    this.repaint()
  }

  private redo(): void {
    if (!this.enabled || !this.redoStack.length) return
    const op = this.redoStack.pop()!
    this.ops.push(op)
    this.bytes += opBytes(op)
    drawOp(this.pctx, op)
    this.refreshHistory()
  }

  /** Paper from the latest checkpoint at or before the op count, then the ops after it. */
  private repaint(): void {
    this.checkpoints = this.checkpoints.filter((c) => c.at <= this.ops.length)
    const base = this.checkpoints[this.checkpoints.length - 1]
    if (base) this.pctx.putImageData(base.image, 0, 0)
    else clearCanvas(this.pctx)
    for (let i = base?.at ?? 0; i < this.ops.length; i++) drawOp(this.pctx, this.ops[i])
    this.refreshHistory()
  }

  private key(e: KeyboardEvent): void {
    if (!this.enabled || !this.el.isConnected) return
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'text' || target.tagName === 'TEXTAREA')) return
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    if (mod && key === 'z') {
      e.preventDefault()
      if (e.shiftKey) this.redo()
      else this.undo()
      return
    }
    if (mod && key === 'y') {
      e.preventDefault()
      this.redo()
      return
    }
    if (mod || e.altKey) return
    if (TOOL_KEYS[key]) {
      this.setTool(TOOL_KEYS[key])
      e.preventDefault()
    } else if (key === '[') {
      this.setSize(this.size - (this.size > 12 ? 4 : 1))
    } else if (key === ']') {
      this.setSize(this.size + (this.size >= 12 ? 4 : 1))
    }
  }
}

