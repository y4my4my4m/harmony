import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// bot-gateway and federation-backend build from their own directories (Docker context), so they
// carry copies of the module; every copy is the same bytes as the one tested here.
const ROOT = resolve(__dirname, '../../..')
const SOURCE = readFileSync(resolve(ROOT, 'src/utils/stripMetadata.ts'), 'utf8')

describe('stripMetadata copies', () => {
  for (const copy of ['bot-gateway/src/utils/stripMetadata.ts', 'federation-backend/src/utils/stripMetadata.ts']) {
    it(`${copy} matches src/utils/stripMetadata.ts`, () => {
      expect(readFileSync(resolve(ROOT, copy), 'utf8') === SOURCE, `cp src/utils/stripMetadata.ts ${copy}`).toBe(true)
    })
  }
})
