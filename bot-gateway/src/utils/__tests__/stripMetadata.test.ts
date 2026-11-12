import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stripMediaFileInPlace } from '../stripMediaFile.js'
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

describe('stripMediaFileInPlace', () => {
  async function withTempFile(name: string, bytes: Uint8Array, run: (file: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'strip-test-'))
    try {
      const file = join(dir, name)
      await writeFile(file, bytes)
      await run(file)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('rewrites an MP4 file to the bytes stripMediaBytes produces', async () => {
    const original = new Uint8Array(readFileSync(resolve(FIXTURES, 'gps.mp4')))
    await withTempFile('gps.mp4', original, async (file) => {
      expect(await stripMediaFileInPlace(file)).toBe(true)
      const expected = await stripMediaBytes(original)
      expect(expected).not.toBe(original)
      expect(new Uint8Array(await readFile(file))).toEqual(expected)
      expect(await stripMediaFileInPlace(file)).toBe(false)
    })
  })

  it('leaves a file without metadata alone', async () => {
    await withTempFile('a.ogg', new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0]), async (file) => {
      expect(await stripMediaFileInPlace(file)).toBe(false)
    })
  })
})
