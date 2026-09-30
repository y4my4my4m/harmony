/**
 * CSS colour parsing and resolution for the theme variable editor.
 *
 * Channels r, g, b are sRGB 0-255; alpha is 0-1.
 */
import { oklchToRgb, rgbToHex } from '@/utils/colorUtils'

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

export interface HexAlpha {
  /** #rrggbb, lowercase; the value an <input type="color"> accepts. */
  hex: string
  alpha: number
}

const NUMBER = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|rad|grad|turn)?$/i

/** `%` maps to `percentOf`; unitless passes through. Angle units are rejected. */
function parseNumber(token: string, percentOf: number): number | null {
  if (token === 'none') return 0
  const m = NUMBER.exec(token)
  if (!m) return null
  const v = parseFloat(m[1])
  if (!m[2]) return v
  if (m[2] === '%') return (v / 100) * percentOf
  return null
}

/** Degrees. */
function parseHue(token: string): number | null {
  if (token === 'none') return 0
  const m = NUMBER.exec(token)
  if (!m) return null
  const v = parseFloat(m[1])
  switch (m[2]?.toLowerCase()) {
    case undefined:
    case 'deg': return v
    case 'rad': return (v * 180) / Math.PI
    case 'grad': return v * 0.9
    case 'turn': return v * 360
    default: return null
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function rgba(r: number, g: number, b: number, a: number): Rgba {
  return {
    r: Math.round(clamp(r, 0, 255)),
    g: Math.round(clamp(g, 0, 255)),
    b: Math.round(clamp(b, 0, 255)),
    a: clamp(a, 0, 1),
  }
}

/**
 * Splits a functional notation body into its components and alpha. Accepts the
 * legacy comma form (alpha as fourth component) and the space form with `/ alpha`.
 */
function splitArgs(body: string): { parts: string[]; alpha: string | null } | null {
  const slash = body.split('/')
  if (slash.length > 2) return null
  const parts = slash[0].trim().split(/\s*,\s*|\s+/).filter(Boolean)
  let alpha = slash.length === 2 ? slash[1].trim() : null
  if (alpha === null && parts.length === 4) alpha = parts.pop()!
  if (parts.length !== 3) return null
  return { parts, alpha }
}

function parseAlpha(token: string | null): number | null {
  return token === null ? 1 : parseNumber(token, 1)
}

function parseHex(value: string): Rgba | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value)
  if (!m) return null
  let h = m[1]
  if (h.length <= 4) h = h.split('').map((c) => c + c).join('')
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
  return rgba(n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1)
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360
  const f = (n: number) => {
    const k = (n + hue / 30) % 12
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

function linearToSrgb(c: number): number {
  const abs = Math.abs(c)
  return abs > 0.0031308 ? Math.sign(c) * (1.055 * Math.pow(abs, 1 / 2.4) - 0.055) : 12.92 * c
}

/** OKLCH lightness is 0-1 here; oklchToRgb takes 0-100. */
function oklchRgb(l: number, c: number, h: number): [number, number, number] {
  const rgb = oklchToRgb(l * 100, Math.max(0, c), h)
  return [rgb.r, rgb.g, rgb.b]
}

function parseFunction(name: string, body: string): Rgba | null {
  if (name === 'color') {
    const m = /^\s*(srgb|srgb-linear)\s+(.*)$/i.exec(body)
    if (!m) return null
    const args = splitArgs(m[2])
    if (!args) return null
    const ch = args.parts.map((p) => parseNumber(p, 1))
    const a = parseAlpha(args.alpha)
    if (ch.some((v) => v === null) || a === null) return null
    const conv = m[1].toLowerCase() === 'srgb-linear' ? linearToSrgb : (v: number) => v
    const [r, g, b] = (ch as number[]).map((v) => conv(v) * 255)
    return rgba(r, g, b, a)
  }

  const args = splitArgs(body)
  if (!args) return null
  const [p0, p1, p2] = args.parts
  const a = parseAlpha(args.alpha)
  if (a === null) return null

  switch (name) {
    case 'rgb':
    case 'rgba': {
      const ch = [p0, p1, p2].map((p) => parseNumber(p, 255))
      if (ch.some((v) => v === null)) return null
      return rgba(ch[0]!, ch[1]!, ch[2]!, a)
    }
    case 'hsl':
    case 'hsla': {
      const h = parseHue(p0)
      // Saturation and lightness are percentages; the modern syntax also allows bare numbers on the same 0-100 scale.
      const s = parseNumber(p1, 100)
      const l = parseNumber(p2, 100)
      if (h === null || s === null || l === null) return null
      const [r, g, b] = hslToRgb(h, clamp(s / 100, 0, 1), clamp(l / 100, 0, 1))
      return rgba(r, g, b, a)
    }
    case 'oklch': {
      // L: 100% = 1. C: 100% = 0.4 (CSS Color 4 reference range).
      const l = parseNumber(p0, 1)
      const c = parseNumber(p1, 0.4)
      const h = parseHue(p2)
      if (l === null || c === null || h === null) return null
      return rgba(...oklchRgb(l, c, h), a)
    }
    case 'oklab': {
      // L: 100% = 1. a, b: 100% = 0.4.
      const l = parseNumber(p0, 1)
      const oa = parseNumber(p1, 0.4)
      const ob = parseNumber(p2, 0.4)
      if (l === null || oa === null || ob === null) return null
      const c = Math.sqrt(oa * oa + ob * ob)
      const h = (Math.atan2(ob, oa) * 180) / Math.PI
      return rgba(...oklchRgb(l, c, h), a)
    }
    default:
      return null
  }
}

/**
 * Parses hex (3, 4, 6, 8 digits), rgb[a](), hsl[a](), oklch(), oklab(),
 * color(srgb | srgb-linear) and `transparent`. Returns null for anything else,
 * including named colours, var(), color-mix(), lab() and lch(); resolveCssColor
 * handles those through the browser.
 */
export function parseCssColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase()
  if (!v) return null
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  if (v.startsWith('#')) return parseHex(v)
  const m = /^([a-z-]+)\(\s*(.*?)\s*\)$/.exec(v)
  if (!m) return null
  return parseFunction(m[1], m[2])
}

export function toHexAlpha(color: Rgba): HexAlpha {
  return { hex: rgbToHex(color.r, color.g, color.b), alpha: Math.round(color.a * 1000) / 1000 }
}

/** #rrggbb when opaque, #rrggbbaa otherwise. Alpha is quantised to 1/255. */
export function formatHexAlpha(hex: string, alpha: number): string {
  const base = hex.trim().toLowerCase().slice(0, 7)
  const a = clamp(alpha, 0, 1)
  if (a >= 1) return base
  return base + Math.round(a * 255).toString(16).padStart(2, '0')
}

/** CSS.supports when present; the local parser otherwise (test environments). */
export function isValidCssColor(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    return CSS.supports('color', v)
  }
  return parseCssColor(v) !== null
}

/** Canvas 2D paints any colour the browser supports into one sRGB pixel. */
function rasterize(value: string): Rgba | null {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  // An unsupported fillStyle is ignored, leaving each sentinel in place.
  ctx.fillStyle = '#000000'
  ctx.fillStyle = value
  const first = ctx.fillStyle
  ctx.fillStyle = '#ffffff'
  ctx.fillStyle = value
  if (ctx.fillStyle !== first) return null
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  return rgba(r, g, b, a / 255)
}

/**
 * Resolves any CSS colour to sRGB. Order: local parser; computed `color` of a
 * probe under `context` (resolves named colours, var(), color-mix() and
 * currentcolor against that element); canvas rasterisation for colour spaces
 * the parser lacks (lab, lch, display-p3).
 */
export function resolveCssColor(value: string, context?: Element): Rgba | null {
  const v = value.trim()
  if (!v) return null
  const direct = parseCssColor(v)
  if (direct) return direct
  if (typeof document === 'undefined' || !isValidCssColor(v)) return null

  const host = context ?? document.documentElement
  const probe = document.createElement('span')
  probe.style.display = 'none'
  probe.style.color = v
  host.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()

  return (computed && parseCssColor(computed)) || rasterize(computed || v)
}
