import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { supabase } from '@/supabase'

// A Drive photo's details come from its upload record; older uploads are read by HTTP range
// through a signed URL, a video by its box headers and moov only.

import { driveFileDetails, type DrivePhotoFile } from '@/services/drive/drivePhotoDetails'
import { storedObjectBytes } from '@/services/privateMedia'

const FIXTURES = resolve(__dirname, '../../../../tests/fixtures/media-metadata')
const bytesOf = (name: string) => new Uint8Array(readFileSync(resolve(FIXTURES, name)))

let ranges: string[]
let ignoreRange: boolean

function serve(body: Uint8Array) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('Range')
    if (!range || ignoreRange) return new Response(body as BodyInit, { status: 200 })
    ranges.push(range)
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range)!.map(Number)
    return new Response(body.slice(start, end + 1) as BodyInit, { status: 206 })
  }))
}

const file = (name: string, size: number, extra: Partial<DrivePhotoFile> = {}): DrivePhotoFile => ({
  bucket: 'message_media', path: `u/uid/${name}`, name, mime_type: name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg',
  size_bytes: size, photo_details: null, photo_location: null, ...extra,
})

beforeEach(() => {
  ranges = []
  ignoreRange = false
  vi.mocked(supabase.storage.from).mockReturnValue({
    createSignedUrl: vi.fn(async (path: string) => ({ data: { signedUrl: `https://signed/${path}` }, error: null })),
  } as never)
})

afterEach(() => vi.unstubAllGlobals())

describe('driveFileDetails', () => {
  it('answers from the upload record without reading the file', async () => {
    serve(new Uint8Array())
    expect(await driveFileDetails(file('a.jpg', 9, { photo_details: 'kept', photo_location: true })))
      .toEqual({ container: null, location: true, details: true })
    expect(await driveFileDetails(file('b.jpg', 9, { photo_details: 'removed', photo_location: false })))
      .toEqual({ container: null, location: false, details: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads an older upload: an image whole, a video by its boxes', async () => {
    const jpeg = bytesOf('gps-rotated.jpg')
    serve(jpeg)
    expect(await driveFileDetails(file('old.jpg', jpeg.length))).toEqual({ container: 'jpeg', location: true, details: true })

    const mp4 = bytesOf('gps.mp4')
    ranges = []
    serve(mp4)
    expect(await driveFileDetails(file('old.mp4', mp4.length))).toEqual({ container: 'isobmff', location: true, details: true })
    const read = ranges.map((r) => /bytes=(\d+)-(\d+)/.exec(r)!).reduce((n, m) => n + Number(m[2]) - Number(m[1]) + 1, 0)
    // The samples (mdat) are never read; each top-level box costs one 32-byte header read.
    const view = new DataView(mp4.buffer, mp4.byteOffset)
    let mdat = 0
    for (let p = 0; p < mp4.length; p += view.getUint32(p)) {
      if (String.fromCharCode(...mp4.subarray(p + 4, p + 8)) === 'mdat') mdat = view.getUint32(p)
    }
    expect(mdat).toBeGreaterThan(500)
    expect(read).toBeLessThan(mp4.length - mdat + 200)
  })

  it('works with a server that ignores Range', async () => {
    ignoreRange = true
    const mp4 = bytesOf('gps.mov')
    serve(mp4)
    expect(await driveFileDetails(file('old.mp4', mp4.length))).toMatchObject({ location: true, details: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('treats a file it cannot read as carrying details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))
    expect(await driveFileDetails(file('locked.jpg', 100))).toEqual({ container: null, location: false, details: true })
  })

  it('skips other files and post media', async () => {
    serve(new Uint8Array())
    expect(await driveFileDetails(file('notes.txt', 5, { mime_type: 'text/plain' }))).toBeNull()
    expect(await driveFileDetails(file('a.jpg', 5, { bucket: 'user_media' }))).toBeNull()
  })
})

describe('storedObjectBytes', () => {
  it('reads [start, end) by range', async () => {
    serve(Uint8Array.from([0, 1, 2, 3, 4, 5]))
    const source = storedObjectBytes('u/uid/x.bin', 6)
    expect(Array.from(await source.read(2, 5))).toEqual([2, 3, 4])
    expect(ranges).toEqual(['bytes=2-4'])
  })
})
