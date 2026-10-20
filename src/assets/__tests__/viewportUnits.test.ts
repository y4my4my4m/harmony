import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Under CSS zoom (Appearance → Zoom level on web and Android) Chromium
// multiplies viewport units by the zoom factor: a 100vh box is 1.5 viewports
// tall at 150% and its bottom edge is off-screen. Styles use the --app-vh,
// --app-dvh, --app-vw, ... variables from design-system.css, which divide the
// multiplier out.

const SRC = join(__dirname, '..', '..')

// The variable definitions, and the probe that measures the multiplier.
const ALLOWED = new Set(['assets/design-system.css', 'utils/appZoom.ts'])

const RAW_UNIT = /(?<![\w.#$-])-?\d*\.?\d+(dvh|svh|lvh|vh|vw|vmin|vmax)\b/g
const COMMENT = /\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(?<![:'"])\/\/[^\n]*/g

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path)
    return /\.(ts|vue|css|scss)$/.test(name) ? [path] : []
  })
}

describe('viewport units', () => {
  it('go through the zoom-corrected variables', () => {
    const offenders: string[] = []
    for (const path of sources(SRC)) {
      const rel = relative(SRC, path)
      if (ALLOWED.has(rel)) continue
      const text = readFileSync(path, 'utf8').replace(COMMENT, '')
      for (const m of text.matchAll(RAW_UNIT)) offenders.push(`${rel}: ${m[0]}`)
    }
    expect(offenders, 'use calc(N * var(--app-vh)) and friends instead of raw viewport units').toEqual([])
  })

  it('defines a variable for every unit', () => {
    const css = readFileSync(join(SRC, 'assets', 'design-system.css'), 'utf8')
    // Heights that end at the iOS keyboard (utils/iosKeyboard.ts).
    for (const unit of ['vh', 'dvh', 'svh']) {
      expect(css).toContain(
        `--app-${unit}: calc((1${unit} - var(--keyboard-inset, 0px) / 100) / var(--viewport-zoom, 1));`,
      )
    }
    for (const unit of ['lvh', 'vw', 'vmin', 'vmax']) {
      expect(css).toContain(`--app-${unit}: calc(1${unit} / var(--viewport-zoom, 1));`)
    }
  })
})
