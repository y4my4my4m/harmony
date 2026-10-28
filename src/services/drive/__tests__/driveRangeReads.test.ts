import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { supabase } from '@/supabase'
import { driveFileDetails, type DrivePhotoFile } from '@/services/drive/drivePhotoDetails'
import { STORED_RANGE_READS } from '@/services/privateMedia'

// An older Drive video is read by HTTP range. A fragmented MP4 (ftyp, moov, then moof+mdat
// pairs) costs a bounded number of requests: small fragments are read through 64 KiB windows,
// and a file needing more than STORED_RANGE_READS requests reports unknown details.

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))

function box(type: string, size: number, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(Math.max(size, 8 + body.length))
  new DataView(out.buffer).setUint32(0, size)
  out.set(ascii(type), 4)
  out.set(body, 8)
  return out
}

/**
 * ftyp, a moov without metadata, then `fragments` pairs of a 100-byte moof and an mdat of
 * `mdatSize` bytes. Bytes are made per request; the file is never held whole.
 */
function fragmentedMovie(fragments: number, mdatSize: number) {
  const head = new Uint8Array([
    ...box('ftyp', 24, new Uint8Array([...ascii('iso5'), 0, 0, 2, 0, ...ascii('iso5'), ...ascii('dash')])),
    ...box('moov', 116, box('mvhd', 108)),
  ])
  const pair = 100 + mdatSize
  const size = head.length + fragments * pair
  const at = (o: number): number => {
    if (o < head.length) return head[o]
    const local = (o - head.length) % pair
    const header = local < 8 ? box('moof', 100) : local >= 100 && local < 108 ? box('mdat', mdatSize) : null
    return header ? header[local < 8 ? local : local - 100] : 0
  }
  const read = (start: number, end: number) => Uint8Array.from({ length: end - start }, (_, i) => at(start + i))
  return { size, read }
}

let requests: number

function serve(movie: { read(start: number, end: number): Uint8Array }) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    requests++
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('Range')!)!.map(Number)
    return new Response(movie.read(start, end + 1) as BodyInit, { status: 206 })
  }))
}

const video = (size: number): DrivePhotoFile => ({
  bucket: 'message_media', path: 'u/uid/old.mp4', name: 'old.mp4', mime_type: 'video/mp4',
  size_bytes: size, photo_details: null, photo_location: null,
})

beforeEach(() => {
  requests = 0
  vi.mocked(supabase.storage.from).mockReturnValue({
    createSignedUrl: vi.fn(async (path: string) => ({ data: { signedUrl: `https://signed/${path}` }, error: null })),
  } as never)
})

afterEach(() => vi.unstubAllGlobals())

describe('Drive range reads of a fragmented MP4', () => {
  it('reads 3000 small boxes through a handful of windows', async () => {
    // 1500 fragments of 300 bytes: 450 KB, eight 64 KiB windows past the first eight headers.
    const movie = fragmentedMovie(1500, 200)
    serve(movie)
    expect(await driveFileDetails(video(movie.size))).toEqual({ container: 'isobmff', location: false, details: false })
    expect(requests).toBeLessThanOrEqual(20)
  })

  it('stops at STORED_RANGE_READS requests and reports unknown details', async () => {
    // 1000 fragments of 1 MiB: one request per fragment.
    const movie = fragmentedMovie(1000, 1 << 20)
    serve(movie)
    expect(await driveFileDetails(video(movie.size))).toEqual({ container: 'isobmff', location: false, details: true, unknown: true })
    expect(requests).toBe(STORED_RANGE_READS)
  })
})
