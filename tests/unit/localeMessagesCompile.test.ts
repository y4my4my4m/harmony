// @vitest-environment node
/**
 * Every message of every locale compiles with vue-i18n's message compiler. A production build
 * throws a compile error at render and takes the component down with it; development logs it and
 * shows the raw text, so journeys on the dev server do not see it. A literal '@' starts a linked
 * message and is written {'@'}; '{', '}' and '|' are syntax as well.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { baseCompile } from '@intlify/message-compiler'
import { describe, expect, it } from 'vitest'

const LOCALES = fileURLToPath(new URL('../../src/locales', import.meta.url))

function* messages(node: unknown, path = ''): Generator<[string, string]> {
  if (typeof node === 'string') {
    yield [path, node]
    return
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) yield* messages(value, path ? `${path}.${key}` : key)
  }
}

describe('locale messages', () => {
  for (const file of readdirSync(LOCALES).filter((name) => name.endsWith('.json'))) {
    it(`${file} compiles`, () => {
      const failures: string[] = []
      for (const [key, source] of messages(JSON.parse(readFileSync(join(LOCALES, file), 'utf8')))) {
        baseCompile(source, {
          warnHtmlMessage: false,
          onError: (error) => failures.push(`${key}: ${error.message}`),
        })
      }
      expect(failures).toEqual([])
    })
  }
})
