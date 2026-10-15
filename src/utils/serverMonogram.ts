/**
 * The icon of a server without one: its initials (up to two) as lit dots of an LED panel, on a
 * colour picked from its name. Rendered as an SVG data URL, so any <img> shows it.
 *
 * Glyphs are 5 columns × 7 rows. A character outside A–Z and 0–9 (CJK, emoji, symbols) gets a
 * left-right mirrored pattern seeded by its code point: still a stable mark per name.
 */

const FONT: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
}

/** Tile colours; white dots on each. #0EA5E9 is the brand blue, used as is. */
const PALETTE = ['#0EA5E9', '#6366F1', '#8B5CF6', '#EC4899', '#F43F5E', '#F97316', '#10B981', '#14B8A6', '#64748B']

const SIZE = 64
const cache = new Map<string, string>()

/** FNV-1a, 32-bit. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** First character of the first two words, upper-cased; accents dropped. Empty for a blank name. */
export function serverInitials(name: string | null | undefined): string[] {
  const words = (name ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(/[\s\-_.·・,/\\|:;]+/u)
    .map((w) => w.replace(/^[^\p{L}\p{N}\p{Extended_Pictographic}]+/u, ''))
    .filter(Boolean)
  return words.slice(0, 2).map((w) => [...w][0].toUpperCase())
}

/** 7 rows of 5 bits for a character; a mirrored pattern seeded by its code point when no glyph exists. */
export function glyphRows(char: string): string[] {
  const known = FONT[char]
  if (known) return known
  let seed = hash(char) || 1
  const rows: string[] = []
  for (let r = 0; r < 7; r++) {
    const half: string[] = []
    for (let c = 0; c < 3; c++) {
      seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) >>> 0
      half.push(seed & 1 ? '1' : '0')
    }
    rows.push(half.join('') + half[1] + half[0])
  }
  return rows
}

/** SVG data URL of the server's dot monogram, cached per name; null for a blank name. */
export function serverMonogramUrl(name: string | null | undefined): string | null {
  const initials = serverInitials(name)
  if (initials.length === 0) return null
  const key = `${initials.join('')}|${(name ?? '').trim().toLowerCase()}`
  const hit = cache.get(key)
  if (hit) return hit

  // Glyph block: 5 columns per letter, one blank column between letters. The panel adds a
  // margin of lit-off cells around it and keeps cells square.
  const glyphs = initials.map(glyphRows)
  const blockCols = glyphs.length * 5 + (glyphs.length - 1)
  const margin = glyphs.length === 1 ? 2 : 1
  const cols = blockCols + margin * 2
  const cell = SIZE / cols
  const rows = Math.floor(SIZE / cell)
  const top = Math.floor((rows - 7) / 2)
  const lit = new Set<string>()
  glyphs.forEach((glyph, g) => {
    glyph.forEach((bits, r) => {
      for (let c = 0; c < 5; c++) {
        if (bits[c] === '1') lit.add(`${margin + g * 6 + c},${top + r}`)
      }
    })
  })

  const yOffset = (SIZE - rows * cell) / 2
  const on: string[] = []
  const off: string[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = (c + 0.5) * cell
      const cy = yOffset + (r + 0.5) * cell
      const point = `M${(cx).toFixed(2)} ${cy.toFixed(2)}h0`
      ;(lit.has(`${c},${r}`) ? on : off).push(point)
    }
  }

  const colour = PALETTE[hash((name ?? '').trim().toLowerCase()) % PALETTE.length]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="#fff" stop-opacity=".18"/><stop offset="1" stop-color="#000" stop-opacity=".12"/>`
    + `</linearGradient></defs>`
    + `<rect width="${SIZE}" height="${SIZE}" fill="${colour}"/><rect width="${SIZE}" height="${SIZE}" fill="url(#g)"/>`
    + `<path d="${off.join('')}" stroke="#fff" stroke-opacity=".16" stroke-width="${(cell * 0.42).toFixed(2)}" stroke-linecap="round"/>`
    + `<path d="${on.join('')}" stroke="#fff" stroke-width="${(cell * 0.74).toFixed(2)}" stroke-linecap="round"/>`
    + `</svg>`
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`
  cache.set(key, url)
  return url
}
