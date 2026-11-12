import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileSource, sniffContainer, stripMediaFileInPlace } from '../stripMediaFile.js'
import { readSourceDetails, stripMediaBytes } from '../stripMetadata.js'

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

describe('sniffContainer', () => {
  // plan() in stripMetadata.ts decides what is stripped; the sniff has to name the same container.
  for (const name of readdirSync(FIXTURES)) {
    it(`names the container of ${name} as stripMetadata does`, async () => {
      const source = await fileSource(resolve(FIXTURES, name))
      try {
        const { container } = await readSourceDetails(source)
        expect(container).not.toBeNull()
        expect(sniffContainer(await source.read(0, 16))).toBe(container === 'heif' ? 'isobmff' : container)
      } finally {
        await source.close()
      }
    })
  }

  it('names the four rasters and ISOBMFF by their leading bytes', () => {
    const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'))
    expect(sniffContainer(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]))).toBe('jpeg')
    expect(sniffContainer(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png')
    expect(sniffContainer(bytes('RIFF\x10\x00\x00\x00WEBPVP8 '))).toBe('webp')
    expect(sniffContainer(bytes('GIF89a\x01\x00\x01\x00'))).toBe('gif')
    expect(sniffContainer(bytes('\x00\x00\x00\x18ftypmp42'))).toBe('isobmff')
    expect(sniffContainer(bytes('\x00\x00\x00\x08wide\x00\x00\x00\x00mdat'))).toBe('isobmff')
  })

  it('names nothing else, and nothing under 8 bytes', () => {
    const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'))
    expect(sniffContainer(bytes('OggS\x00\x02\x00\x00\x00\x00'))).toBeNull()
    expect(sniffContainer(bytes('RIFF\x10\x00\x00\x00WAVEfmt '))).toBeNull()
    expect(sniffContainer(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffContainer(bytes('%PDF-1.7\n'))).toBeNull()
    expect(sniffContainer(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull()
    expect(sniffContainer(new Uint8Array(0))).toBeNull()
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

  // Every ISOBMFF fixture, HEIF and AVIF photos included: the mirror strips these on disk.
  for (const name of readdirSync(FIXTURES).filter((n) => /\.(mp4|mov|heic|avif)$/.test(n))) {
    it(`rewrites ${name} to the bytes stripMediaBytes produces`, async () => {
      const original = new Uint8Array(readFileSync(resolve(FIXTURES, name)))
      await withTempFile(name, original, async (file) => {
        expect(await stripMediaFileInPlace(file)).toBe(true)
        const stripped = new Uint8Array(await readFile(file))
        expect(stripped).toEqual(await stripMediaBytes(original))
        expect(MARKERS.filter((m) => Buffer.from(stripped).toString('latin1').includes(m))).toEqual([])
      })
    })
  }

  it('leaves a file without metadata alone', async () => {
    await withTempFile('a.ogg', new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0]), async (file) => {
      expect(await stripMediaFileInPlace(file)).toBe(false)
    })
  })
})
