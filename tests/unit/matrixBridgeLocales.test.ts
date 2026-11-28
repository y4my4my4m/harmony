// @vitest-environment node
/** Every locale has the Matrix bridge strings of en.json, with the same named values. */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const LOCALES = fileURLToPath(new URL('../../src/locales', import.meta.url))

/** Key path → the sorted names of its {values}; a literal such as {'@'} is none. */
function shape(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') out[path] = [...new Set(node.match(/\{[a-zA-Z]+\}/g) ?? [])].sort().join(' ')
    else for (const [key, value] of Object.entries(node as object)) walk(value, `${path}.${key}`)
  }
  const { matrixBridge, bridges } = JSON.parse(readFileSync(join(LOCALES, file), 'utf8'))
  walk(matrixBridge, 'matrixBridge')
  walk(bridges, 'bridges')
  return out
}

describe('Matrix bridge strings', () => {
  const english = shape('en.json')
  for (const file of readdirSync(LOCALES).filter((name) => name.endsWith('.json') && name !== 'en.json')) {
    it(`${file} has them all`, () => {
      expect(shape(file)).toEqual(english)
    })
  }
})
