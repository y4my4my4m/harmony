import { describe, it, expect, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: null }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: null }) }))
vi.mock('@/services/AudioThemeService', () => ({
  audioThemeService: { getSettings: () => ({ selectedTheme: 'default' }), setTheme: vi.fn() },
}))

import { BUILTIN_SKINS } from '../index'
import { resolveSkin, type VisualThemeSettings } from '../../useVisualTheme'

const PUBLIC = resolve(__dirname, '../../../../public')

function baseSettings(): VisualThemeSettings {
  return {
    theme: 'dark',
    customThemeMode: 'dark',
    customPrimaryColor: '#0EA5E9',
    customAccentColor: '#0EA5E9',
    customBackgroundColor: '#0EA5E9',
    customBackgroundLightness: 0,
    customBackgroundChroma: 0,
    customSidebarColor: '#ff00aa',
    customCssOverrides: {},
    fontFamily: 'system',
    activeSkinId: null,
  } as VisualThemeSettings
}

/** Rule preludes outside @keyframes, comments stripped. */
function selectorsOf(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  let depth = 0
  let buf = ''
  const inKeyframes: boolean[] = []
  for (const ch of src) {
    if (ch === '{') {
      const prelude = buf.trim()
      const keyframes = prelude.startsWith('@keyframes')
      const parentKeyframes = inKeyframes[inKeyframes.length - 1] ?? false
      if (prelude && !prelude.startsWith('@') && !parentKeyframes) out.push(prelude)
      inKeyframes.push(keyframes || parentKeyframes)
      depth++
      buf = ''
    } else if (ch === '}') {
      inKeyframes.pop()
      depth--
      buf = ''
    } else if (ch === ';' && depth > 0) {
      buf = ''
    } else {
      buf += ch
    }
  }
  return out
}

/** Splits a selector list on top-level commas. */
function splitList(prelude: string): string[] {
  const parts: string[] = []
  let level = 0
  let cur = ''
  for (const ch of prelude) {
    if (ch === '(') level++
    if (ch === ')') level--
    if (ch === ',' && level === 0) {
      parts.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

describe('skin registry', () => {
  it('has unique ids and kebab-case option ids', () => {
    const ids = BUILTIN_SKINS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const skin of BUILTIN_SKINS) {
      const optionIds = (skin.options ?? []).map((o) => o.id)
      expect(new Set(optionIds).size).toBe(optionIds.length)
      for (const id of optionIds) expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })

  // Vitest stubs CSS imports, so loadCss resolves empty here; read the source.
  it.each(BUILTIN_SKINS.map((s) => [s.id] as const))('%s scopes every rule to its data-skin attribute', (id) => {
    const scope = `:root[data-skin="${id}"]`
    const css = readFileSync(resolve(__dirname, '..', id, 'skin.css'), 'utf8')
    const selectors = selectorsOf(css).flatMap(splitList)
    expect(selectors.length).toBeGreaterThan(10)
    for (const sel of selectors) expect(sel.startsWith(scope), sel).toBe(true)
  })

  it.each(BUILTIN_SKINS.filter((s) => s.preview).map((s) => [s.id, s.preview!] as const))('%s preview exists', (_id, preview) => {
    expect(existsSync(resolve(PUBLIC, preview.replace(/^\//, '')))).toBe(true)
  })
})

describe('skyglass', () => {
  it('applies a light custom theme and clears a stored sidebar hue', () => {
    const next = resolveSkin(baseSettings(), 'skyglass')
    expect(next.activeSkinId).toBe('skyglass')
    expect(next.theme).toBe('custom')
    expect(next.customThemeMode).toBe('light')
    expect(next.customSidebarColor).toBe('')
    expect(next.customSkinCss).toBe('')
  })

  it('restores the pre-skin settings when cleared', () => {
    const base = baseSettings()
    const cleared = resolveSkin(resolveSkin(base, 'skyglass'), null)
    expect(cleared.activeSkinId).toBeNull()
    expect(cleared.customSidebarColor).toBe('#ff00aa')
    expect(cleared.theme).toBe(base.theme)
  })
})

describe.each(['skyglass', 'lattice', 'flux'])('%s', (id) => {
  const skin = BUILTIN_SKINS.find((s) => s.id === id)!

  it('declares a ui-sounds option and links a generated pack whose files all exist', () => {
    expect(skin.options?.some((o) => o.id === 'ui-sounds')).toBe(true)
    expect(skin.linkedAudioTheme).toBe(id)
    const manifest = JSON.parse(readFileSync(resolve(PUBLIC, `assets/sounds/${id}/manifest.json`), 'utf8'))
    expect(manifest.theme.id).toBe(id)
    const files = Object.values(manifest.theme.sounds) as string[]
    expect(files.length).toBe(27)
    for (const f of files) expect(existsSync(resolve(PUBLIC, `assets/sounds/${id}`, f)), f).toBe(true)
  })

  it('loads its stylesheet lazily', () => {
    expect(typeof skin.loadCss).toBe('function')
    expect((skin as { globalCss?: unknown }).globalCss).toBeUndefined()
  })
})

describe('lattice layout', () => {
  // Layout must go through data-region hooks, and only at desktop widths.
  const css = readFileSync(resolve(__dirname, '..', 'lattice', 'skin.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  it('moves regions only inside a desktop media query', () => {
    const layoutProps = /\b(gap|margin-left|left|bottom|padding-top|padding-bottom|max-width|margin-inline)\s*:/
    const blocks = css.split('@media')
    const outside = blocks[0]
    for (const rule of outside.split('}')) {
      if (/data-region="(rail|nav|workspace|main|aside|user|messages)"/.test(rule) && !/data-region="composer"/.test(rule)) {
        expect(layoutProps.test(rule), rule.trim()).toBe(false)
      }
    }
  })
})

/** Style rules with their declaration text and enclosing at-rule preludes, comments stripped. */
function rulesOf(css: string): { selector: string; body: string; at: string[] }[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: { selector: string; body: string; at: string[] }[] = []
  const stack: string[] = []
  let buf = ''
  for (const ch of src) {
    if (ch === '{') {
      stack.push(buf.trim())
      buf = ''
    } else if (ch === '}') {
      const prelude = stack.pop() ?? ''
      if (prelude && !prelude.startsWith('@') && !stack.some((p) => p.startsWith('@keyframes'))) {
        out.push({ selector: prelude, body: buf, at: stack.filter((p) => p.startsWith('@')) })
      }
      buf = ''
    } else {
      buf += ch
    }
  }
  return out
}

describe('paper', () => {
  const skin = BUILTIN_SKINS.find((s) => s.id === 'paper')!
  const css = readFileSync(resolve(__dirname, '..', 'paper', 'skin.css'), 'utf8')
  const rules = rulesOf(css)
  const decls = (r: { body: string }) => r.body.split(';').map((d) => d.trim()).filter(Boolean)

  it('applies a light custom theme on the mascot blue and clears a stored sidebar hue', () => {
    const next = resolveSkin(baseSettings(), 'paper')
    expect(next.activeSkinId).toBe('paper')
    expect(next.theme).toBe('custom')
    expect(next.customThemeMode).toBe('light')
    expect(next.customPrimaryColor).toBe('#0EA5E9')
    expect(next.customSidebarColor).toBe('')
    expect(next.customSkinCss).toBe('')
  })

  it('restores the pre-skin settings when cleared', () => {
    const base = baseSettings()
    const cleared = resolveSkin(resolveSkin(base, 'paper'), null)
    expect(cleared.activeSkinId).toBeNull()
    expect(cleared.customSidebarColor).toBe('#ff00aa')
    expect(cleared.customThemeMode).toBe(base.customThemeMode)
    expect(cleared.theme).toBe(base.theme)
  })

  it('loads its stylesheet lazily and declares its toggles, glyph wallpaper off', () => {
    expect(typeof skin.loadCss).toBe('function')
    expect(skin.loadScene).toBeUndefined()
    expect((skin as { globalCss?: unknown }).globalCss).toBeUndefined()
    expect((skin.options ?? []).map((o) => o.id)).toEqual(['shadows', 'jelly', 'grain', 'glyphs'])
    expect(skin.options?.find((o) => o.id === 'glyphs')?.default).toBe(false)
  })

  it('ships every font file its stylesheet declares', () => {
    const urls = [...css.matchAll(/url\('(\/assets\/fonts\/[^']+)'\)/g)].map((m) => m[1])
    expect(urls.length).toBe(3)
    for (const url of urls) expect(existsSync(resolve(PUBLIC, url.slice(1))), url).toBe(true)
    expect(existsSync(resolve(PUBLIC, 'assets/fonts/paper/OFL.txt'))).toBe(true)
  })

  // The brand blue fill is never darkened, and High contrast keeps its own fills.
  it('keeps the brand blue fill and leaves high-contrast fills alone', () => {
    const blues = [...css.matchAll(/--pp-blue:\s*([^;]+);/g)].map((m) => m[1].trim())
    expect(blues).toEqual(['#0EA5E9'])
    expect(css).not.toMatch(/--harmony-primary:/)
    const fillRules = rules.filter((r) => /--harmony-primary-fill:/.test(r.body))
    expect(fillRules.length).toBe(1)
    expect(fillRules[0].selector).toContain(':not([data-high-contrast="true"])')
    const contrast = rules.find((r) => r.selector === ':root[data-skin="paper"][data-high-contrast="true"]')
    expect(contrast?.body).toMatch(/--pp-fill-blue:\s*var\(--harmony-primary-fill\)/)
    expect(contrast?.body).toMatch(/--pp-fill-red:\s*var\(--error-fill\)/)
  })

  // Inset margin marks may be red; offset shadows are ink, or blue under a focused field.
  it('keeps red-orange out of offset shadows', () => {
    for (const r of rules) {
      for (const decl of decls(r)) {
        if (/^box-shadow\s*:/.test(decl) && !/\binset\b/.test(decl)) {
          expect(decl, r.selector).not.toMatch(/--pp-red|#EB4E2C/i)
        }
      }
    }
  })

  it('strips dialogs and the settings window, solid only while focused, with the close box in the strip', () => {
    const strip = rules.find((r) => r.selector.includes('.modal-container') && r.selector.endsWith('::before') && r.body.includes('repeating-linear-gradient(to bottom, var(--pp-stripe) '))
    expect(strip?.selector).toContain('.user-settings-container')
    const faint = rules.find((r) => r.selector === ':root[data-skin="paper"]')
    expect(faint?.body).toMatch(/--pp-stripe:\s*color-mix\(in srgb, var\(--pp-frame\) \d+%, transparent\)/)
    const solid = rules.filter((r) => /--pp-stripe:\s*var\(--pp-frame\)/.test(r.body)).map((r) => r.selector)
    expect(solid.some((s) => s.includes('.modal-container, .user-settings-container):focus-within'))).toBe(true)
    expect(solid.some((s) => s.includes('[data-region="main"]:focus-within'))).toBe(true)
    const box = rules.find((r) => r.selector.includes('.modal-container > .modal-header > :is(.close-button, .modal-close)') && /position:\s*absolute/.test(r.body))
    expect(box?.selector).toContain('.user-settings-container > .settings-close')
  })

  it('draws the glyph wallpaper from a static asset, only with the option on and outside high contrast', () => {
    const wall = rules.filter((r) => r.body.includes('/assets/skins/paper/glyphs.svg'))
    expect(wall.length).toBe(1)
    expect(wall[0].selector).toContain('[data-skin-glyphs="on"]')
    expect(wall[0].selector).toContain(':not([data-high-contrast="true"])')
    expect(wall[0].body).not.toMatch(/animation/)
    const svg = readFileSync(resolve(PUBLIC, 'assets/skins/paper/glyphs.svg'), 'utf8')
    expect(svg).not.toMatch(/<(script|animate|set|foreignObject)\b/)
    expect(svg).not.toMatch(/\bhref=/)
    expect(svg.length).toBeLessThan(40_000)
  })

  it('runs jelly only with the option on and motion allowed', () => {
    const jelly = rules.filter((r) => /harmony-paper-jelly/.test(r.body))
    expect(jelly.length).toBeGreaterThan(0)
    for (const r of jelly) {
      expect(r.at).toContain('@media (prefers-reduced-motion: no-preference)')
      for (const sel of splitList(r.selector)) {
        expect(sel).toContain('[data-skin-jelly="on"]')
        expect(sel).toContain(':not([data-reduce-motion="true"])')
      }
    }
  })

  // The chat window moves the main region; below 769px nav, rail and aside are touch drawers.
  it('frames regions only inside a desktop media query', () => {
    const layoutProps = /\b(margin|padding-bottom|left|right|top|bottom|flex-direction)\s*:/
    for (const r of rules) {
      if (/data-region="(main|nav|rail|aside|workspace|user)"/.test(r.selector) && layoutProps.test(r.body)) {
        expect(r.at, r.selector).toContain('@media (min-width: 769px)')
      }
    }
  })
})

describe('flux', () => {
  const skin = BUILTIN_SKINS.find((s) => s.id === 'flux')!

  it('loads its scene lazily and lets the layout and every scene layer be switched off', () => {
    expect(typeof skin.loadScene).toBe('function')
    const ids = (skin.options ?? []).map((o) => o.id)
    for (const id of ['dock', 'lens', 'liquid', 'drift', 'orbits']) expect(ids).toContain(id)
  })

  // The horizontal layout moves regions; it must stay off phones, where nav,
  // rail and aside are touch drawers.
  it('moves regions only inside desktop media queries', () => {
    const css = readFileSync(resolve(__dirname, '..', 'flux', 'skin.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const outside = css.split('@media')[0]
    for (const rule of outside.split('}')) {
      if (/data-region="(rail|workspace|user)"/.test(rule)) {
        expect(/\b(flex-direction|top|left|right|bottom|gap|max-width)\s*:/.test(rule), rule.trim()).toBe(false)
      }
    }
  })
})
