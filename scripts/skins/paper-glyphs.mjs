#!/usr/bin/env node
/**
 * Writes the Paper skin's glyph wallpaper to public/assets/skins/paper/glyphs.svg.
 *
 *   node scripts/skins/paper-glyphs.mjs
 *
 * A grid of monospace cells over one period of a Chladni plate,
 *   f(x, y) = cos(nπx)·cos(mπy) − cos(mπx)·cos(nπy),  x, y in [-1, 1),
 * after the GlyphField wallpaper of the v2 site. A cell prints a character
 * of chat text where |f| is small: the nodal lines sand traces on the plate.
 * f has period 2 on both axes for integer modes, so the tile repeats without
 * a seam. Two modes are summed so the repeat is less regular.
 *
 * Fill is a warm mid grey at low opacity, which reads as faint ink on the
 * light paper and faint chalk on the dark desk; skin.css uses one file for
 * both themes.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(ROOT, 'public/assets/skins/paper/glyphs.svg')

// Tile and cell size in CSS px. 98 x 56 cells.
const SIZE = 784
const CELL_W = 8
const CELL_H = 14
const FONT_SIZE = 10

// Plate modes (n, m) and weights.
const MODES = [
  [3, 2, 1],
  [1, 4, 0.4],
]

// |f| thresholds for the line core and its halo, as a fraction of max |f|.
const CORE = 0.1
const HALO = 0.22

const FILL = '#8C8576'
const CORE_OPACITY = 0.12
const HALO_OPACITY = 0.05

const CORPUS = [
  'anyone around for voice?', 'pushed the new build', '#general', 'gg', 'brb tea',
  '@here stream in 5', 'Follow', 'Accept', 'Create(Note)', 'Announce', ':wave:',
  'joined from my own instance', 'pinned a message', 'lgtm', 'shipping it', 'night all',
  'thread: patch notes', 'reacted :heart:', 'typing...', 'welcome in', 'invite sent',
].join(' / ')

const chladni = (x, y, n, m) =>
  Math.cos(n * Math.PI * x) * Math.cos(m * Math.PI * y) - Math.cos(m * Math.PI * x) * Math.cos(n * Math.PI * y)

const cols = SIZE / CELL_W
const rows = SIZE / CELL_H
const field = []
let max = 0
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const x = -1 + (2 * (c + 0.5)) / cols
    const y = -1 + (2 * (r + 0.5)) / rows
    const v = MODES.reduce((s, [n, m, w]) => s + w * chladni(x, y, n, m), 0)
    field.push(v)
    max = Math.max(max, Math.abs(v))
  }
}

const esc = (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch] ?? ch
const layers = { core: [], halo: [] }
for (let r = 0; r < rows; r++) {
  const lines = { core: { xs: [], text: '' }, halo: { xs: [], text: '' } }
  for (let c = 0; c < cols; c++) {
    const a = Math.abs(field[r * cols + c]) / max
    const layer = a < CORE ? 'core' : a < HALO ? 'halo' : null
    if (!layer) continue
    const ch = CORPUS[(r * 37 + c) % CORPUS.length]
    if (ch === ' ') continue
    lines[layer].xs.push(c * CELL_W + 1)
    lines[layer].text += esc(ch)
  }
  const y = r * CELL_H + 10.5
  for (const layer of ['core', 'halo']) {
    const line = lines[layer]
    if (line.xs.length) layers[layer].push(`<text x="${line.xs.join(' ')}" y="${y}">${line.text}</text>`)
  }
}

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
  `<g font-family="ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="${FONT_SIZE}" fill="${FILL}">`,
  `<g fill-opacity="${CORE_OPACITY}">`,
  ...layers.core,
  '</g>',
  `<g fill-opacity="${HALO_OPACITY}">`,
  ...layers.halo,
  '</g>',
  '</g>',
  '</svg>',
  '',
].join('\n')

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, svg)
const glyphs = layers.core.concat(layers.halo).join('').replace(/<[^>]+>/g, '').length
console.log(`${OUT}: ${glyphs} glyphs, ${(svg.length / 1024).toFixed(1)} KB`)
