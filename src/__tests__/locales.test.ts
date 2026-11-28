import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { baseCompile } from '@intlify/message-compiler'

const DIR = resolve(__dirname, '../locales')

function flatten(node: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) flatten(v, prefix ? `${prefix}.${k}` : k, out)
  } else {
    out[prefix] = String(node)
  }
  return out
}

function load(code: string): Record<string, string> {
  return flatten(JSON.parse(readFileSync(resolve(DIR, `${code}.json`), 'utf8')))
}

//Literal interpolations ({'@'}, {'|'}) are text, not placeholders.
function placeholders(msg: string): string[] {
  return [...new Set([...msg.matchAll(/\{\s*([^}'\s]+)\s*\}/g)].map((m) => m[1]))].sort()
}

function pluralSegments(msg: string): number {
  return msg.replace(/\{'[^']*'\}/g, '').split('|').length
}

//Japanese, Korean and Chinese have one plural form.
const SINGLE_FORM = new Set(['ja', 'ko', 'zh'])

const en = load('en')
const locales = readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && f !== 'en.json')
  .map((f) => f.replace(/\.json$/, ''))

describe('locale files', () => {
  it('compile in English', () => {
    const broken: string[] = []
    for (const [key, msg] of Object.entries(en)) {
      baseCompile(msg, { onError: (e) => broken.push(`${key}: ${e.message}`) })
    }
    expect(broken).toEqual([])
  })

  for (const code of locales) {
    describe(code, () => {
      const messages = load(code)

      it('has every English key and no other', () => {
        expect(Object.keys(en).filter((k) => !(k in messages))).toEqual([])
        expect(Object.keys(messages).filter((k) => !(k in en))).toEqual([])
      })

      it('keeps the placeholders and plural forms of English', () => {
        const wrong: string[] = []
        for (const [key, source] of Object.entries(en)) {
          const msg = messages[key]
          if (msg === undefined) continue
          if (placeholders(msg).join() !== placeholders(source).join()) wrong.push(`${key}: placeholders`)
          const forms = pluralSegments(msg)
          if (forms !== pluralSegments(source) && !(forms === 1 && SINGLE_FORM.has(code))) wrong.push(`${key}: plural forms`)
        }
        expect(wrong).toEqual([])
      })

      it('compiles', () => {
        const broken: string[] = []
        for (const [key, msg] of Object.entries(messages)) {
          baseCompile(msg, { onError: (e) => broken.push(`${key}: ${e.message}`) })
        }
        expect(broken).toEqual([])
      })
    })
  }
})
