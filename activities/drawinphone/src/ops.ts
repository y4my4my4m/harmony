/**
 * Drawing op log and its wire form.
 *
 * Coordinates are logical canvas units: the canvas is 800 x 600 logical px, stored at QUANT units per
 * px (0..1600, 0..1200). Pressure is 0..255. Colours are 0xRRGGBB, alpha 1..100 (percent), size
 * 1..100 logical px.
 *
 * Wire form: "d1." + base64url of a byte stream. Unsigned varints (LEB128), zigzag for signed deltas.
 *   op tag   1 stroke, 2 eraser stroke, 3 line, 4 rect, 5 ellipse, 6 fill, 7 clear
 *   stroke   rgb(3) alpha(1) size(1) count(varint) x0 y0 (varint) p0(1) then per point dx dy (zigzag) dp (zigzag)
 *   eraser   size(1) count(varint) points as stroke
 *   shapes   rgb(3) alpha(1) size(1) x0 y0 x1 y1 (varint)
 *   fill     rgb(3) alpha(1) x y (varint)
 */

export const LOGICAL_W = 800
export const LOGICAL_H = 600
export const QUANT = 2
export const DRAWING_MAX_BYTES = 200 * 1024
const PREFIX = 'd1.'

export type ShapeKind = 'line' | 'rect' | 'ellipse'

export type Op =
  | { k: 'stroke'; color: number; alpha: number; size: number; pts: number[] }
  | { k: 'erase'; size: number; pts: number[] }
  | { k: ShapeKind; color: number; alpha: number; size: number; x0: number; y0: number; x1: number; y1: number }
  | { k: 'fill'; color: number; alpha: number; x: number; y: number }
  | { k: 'clear' }

const TAG = { stroke: 1, erase: 2, line: 3, rect: 4, ellipse: 5, fill: 6, clear: 7 } as const
const KIND: Record<number, Op['k']> = { 1: 'stroke', 2: 'erase', 3: 'line', 4: 'rect', 5: 'ellipse', 6: 'fill', 7: 'clear' }

const MAX_X = LOGICAL_W * QUANT
const MAX_Y = LOGICAL_H * QUANT

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)))

class Writer {
  bytes: number[] = []
  u(v: number): void {
    v = Math.max(0, Math.floor(v))
    while (v >= 0x80) {
      this.bytes.push((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    this.bytes.push(v)
  }
  s(v: number): void {
    this.u(v >= 0 ? v * 2 : -v * 2 - 1)
  }
  b(v: number): void {
    this.bytes.push(v & 0xff)
  }
  rgb(c: number): void {
    this.b(c >> 16)
    this.b(c >> 8)
    this.b(c)
  }
}

class Reader {
  i = 0
  constructor(private readonly bytes: Uint8Array) {}
  get done(): boolean {
    return this.i >= this.bytes.length
  }
  b(): number {
    if (this.i >= this.bytes.length) throw new Error('truncated')
    return this.bytes[this.i++]
  }
  u(): number {
    let v = 0
    let mul = 1
    for (let n = 0; n < 6; n++) {
      const byte = this.b()
      v += (byte & 0x7f) * mul
      if (byte < 0x80) return v
      mul *= 128
    }
    throw new Error('varint too long')
  }
  s(): number {
    const v = this.u()
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2
  }
  rgb(): number {
    return (this.b() << 16) | (this.b() << 8) | this.b()
  }
}

function writePoints(w: Writer, pts: number[]): void {
  const count = Math.floor(pts.length / 3)
  w.u(count)
  let px = 0
  let py = 0
  let pp = 0
  for (let i = 0; i < count; i++) {
    const x = clampInt(pts[i * 3], 0, MAX_X)
    const y = clampInt(pts[i * 3 + 1], 0, MAX_Y)
    const p = clampInt(pts[i * 3 + 2], 0, 255)
    if (i === 0) {
      w.u(x)
      w.u(y)
      w.b(p)
    } else {
      w.s(x - px)
      w.s(y - py)
      w.s(p - pp)
    }
    px = x
    py = y
    pp = p
  }
}

function readPoints(r: Reader): number[] {
  const count = r.u()
  if (count > 200_000) throw new Error('too many points')
  const pts: number[] = new Array(count * 3)
  let x = 0
  let y = 0
  let p = 0
  for (let i = 0; i < count; i++) {
    if (i === 0) {
      x = r.u()
      y = r.u()
      p = r.b()
    } else {
      x += r.s()
      y += r.s()
      p += r.s()
    }
    pts[i * 3] = clampInt(x, 0, MAX_X)
    pts[i * 3 + 1] = clampInt(y, 0, MAX_Y)
    pts[i * 3 + 2] = clampInt(p, 0, 255)
  }
  return pts
}

function writeOp(w: Writer, op: Op): void {
  w.b(TAG[op.k])
  switch (op.k) {
    case 'stroke':
      w.rgb(op.color)
      w.b(clampInt(op.alpha, 1, 100))
      w.b(clampInt(op.size, 1, 100))
      writePoints(w, op.pts)
      break
    case 'erase':
      w.b(clampInt(op.size, 1, 100))
      writePoints(w, op.pts)
      break
    case 'line':
    case 'rect':
    case 'ellipse':
      w.rgb(op.color)
      w.b(clampInt(op.alpha, 1, 100))
      w.b(clampInt(op.size, 1, 100))
      w.u(clampInt(op.x0, 0, MAX_X))
      w.u(clampInt(op.y0, 0, MAX_Y))
      w.u(clampInt(op.x1, 0, MAX_X))
      w.u(clampInt(op.y1, 0, MAX_Y))
      break
    case 'fill':
      w.rgb(op.color)
      w.b(clampInt(op.alpha, 1, 100))
      w.u(clampInt(op.x, 0, MAX_X))
      w.u(clampInt(op.y, 0, MAX_Y))
      break
    case 'clear':
      break
  }
}

function readOp(r: Reader): Op {
  const kind = KIND[r.b()]
  switch (kind) {
    case 'stroke':
      return { k: 'stroke', color: r.rgb(), alpha: r.b(), size: r.b(), pts: readPoints(r) }
    case 'erase':
      return { k: 'erase', size: r.b(), pts: readPoints(r) }
    case 'line':
    case 'rect':
    case 'ellipse':
      return { k: kind, color: r.rgb(), alpha: r.b(), size: r.b(), x0: r.u(), y0: r.u(), x1: r.u(), y1: r.u() }
    case 'fill':
      return { k: 'fill', color: r.rgb(), alpha: r.b(), x: r.u(), y: r.u() }
    case 'clear':
      return { k: 'clear' }
    default:
      throw new Error('unknown op')
  }
}

function toBase64Url(bytes: number[] | Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...Array.prototype.slice.call(bytes, i, i + CHUNK))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Bytes one op adds to the stream. */
export function opBytes(op: Op): number {
  const w = new Writer()
  writeOp(w, op)
  return w.bytes.length
}

/** Encoded length of a stream of `bytes` raw bytes. */
export function encodedLength(bytes: number): number {
  return PREFIX.length + Math.ceil((bytes * 4) / 3)
}

export function encodeOps(ops: Op[]): string {
  const w = new Writer()
  for (const op of ops) writeOp(w, op)
  return PREFIX + toBase64Url(w.bytes)
}

/** The ops of an encoded drawing; throws on anything malformed or over DRAWING_MAX_BYTES. */
export function decodeOps(text: string): Op[] {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) throw new Error('not a drawing')
  if (text.length > DRAWING_MAX_BYTES) throw new Error('drawing too large')
  const r = new Reader(fromBase64Url(text.slice(PREFIX.length)))
  const ops: Op[] = []
  while (!r.done) {
    ops.push(readOp(r))
    if (ops.length > 50_000) throw new Error('too many ops')
  }
  return ops
}

/** decodeOps, or no ops for anything malformed. */
export function decodeOpsSafe(text: string): Op[] {
  try {
    return decodeOps(text)
  } catch {
    return []
  }
}

/** Strokes, shapes and fills: the "detail" of a drawing. */
export function countMarks(ops: Op[]): number {
  return ops.filter((op) => op.k !== 'clear').length
}

export function rgbToHex(color: number): string {
  return '#' + (color & 0xffffff).toString(16).padStart(6, '0')
}

export function hexToRgb(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  return m ? parseInt(m[1], 16) : 0
}
