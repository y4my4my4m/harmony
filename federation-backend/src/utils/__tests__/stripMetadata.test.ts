import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stripMediaBytes } from '../stripMetadata.js'

// The frontend's module (src/utils/stripMetadata.ts, copied byte for byte) under Node, on the
// shared fixtures: no fixture keeps its metadata strings, and the output is stable.
const FIXTURES = resolve(__dirname, '../../../../tests/fixtures/media-metadata')
const MARKERS = ['HarmonyCam', 'GPSLatitude', '+35.6762', 'Tokyo', 'fixture comment', 'TRAILER', 'ISO6709']

describe('stripMediaBytes under Node', () => {
  for (const name of readdirSync(FIXTURES)) {
    it(`strips ${name}`, async () => {
      const input = new Uint8Array(readFileSync(resolve(FIXTURES, name)))
      expect(MARKERS.some((m) => Buffer.from(input).toString('latin1').includes(m))).toBe(true)
      const output = await stripMediaBytes(input)
      const text = Buffer.from(output).toString('latin1')
      expect(MARKERS.filter((m) => text.includes(m))).toEqual([])
      expect(await stripMediaBytes(output)).toBe(output)
    })
  }

  it('returns other bytes unchanged', async () => {
    const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2])
    expect(await stripMediaBytes(ogg)).toBe(ogg)
  })
})
