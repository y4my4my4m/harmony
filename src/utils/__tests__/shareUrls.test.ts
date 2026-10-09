import { describe, it, expect, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { resolveHarmonyBaseUrl } from '@/utils/discordBridgeSetup'

// The desktop and Android builds load the app from tauri://localhost or
// http://tauri.localhost: a link built from the page origin points at the local
// webview, not the instance. Links people share or receive by email go through
// resolveHarmonyBaseUrl().

const SRC = join(__dirname, '..', '..')

// Page-origin URLs that never leave this webview.
const PAGE_ORIGIN_SITES = new Map<string, string>([
  ['components/AuthComponent.vue', 'OAuth redirectTo: the desktop popup flow intercepts it in the webview'],
])

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path)
    return /\.(ts|vue)$/.test(name) ? [path] : []
  })
}

/** Opening tags named `name`; a `>` inside a quoted attribute value does not end a tag. */
function openingTags(text: string, name: string): string[] {
  const tags: string[] = []
  const re = new RegExp(`<${name}\\b`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    let quote: string | null = null
    let i = m.index + m[0].length
    for (; i < text.length; i++) {
      const c = text[i]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === '>') {
        break
      }
    }
    tags.push(text.slice(m.index, i + 1))
  }
  return tags
}

describe('share URLs', () => {
  afterEach(() => {
    delete (globalThis as any).__TAURI_INTERNALS__
    localStorage.removeItem('harmony.instance')
  })

  it('builds no link from the page origin, except the listed sites', () => {
    const found: string[] = []
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file)
      if (/\$\{\s*window\.location\.origin\s*\}\//.test(readFileSync(file, 'utf-8')) && !PAGE_ORIGIN_SITES.has(rel)) {
        found.push(rel)
      }
    }
    expect(found).toEqual([])
  })

  it('uses the stored instance origin in the desktop app', () => {
    ;(globalThis as any).__TAURI_INTERNALS__ = {}
    localStorage.setItem('harmony.instance', JSON.stringify({
      origin: 'https://har.mony.lol/',
      name: 'Harmony',
      supabaseUrl: 'https://db.mony.lol',
      supabaseAnonKey: 'anon',
    }))
    expect(resolveHarmonyBaseUrl()).toBe('https://har.mony.lol')
  })
})

describe('reorderable lists', () => {
  // Tauri's WebView2 drag-drop handler, on for OS file drops, swallows HTML5
  // drag and drop on Windows; SortableJS's pointer fallback is unaffected.
  it('every <draggable> uses the pointer fallback', () => {
    const missing: string[] = []
    for (const file of sources(SRC)) {
      if (!file.endsWith('.vue')) continue
      const text = readFileSync(file, 'utf-8')
      for (const tag of openingTags(text, 'draggable')) {
        if (!/:force-fallback="true"/.test(tag)) missing.push(relative(SRC, file))
      }
    }
    expect(missing).toEqual([])
  })
})
