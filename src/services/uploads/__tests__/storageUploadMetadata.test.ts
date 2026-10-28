import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { supabase } from '@/supabase'

// Photo metadata and the shared storage upload: a TUS upload stored for resuming is continued
// only by an upload of the same choice (details kept or removed), and audio goes up as picked.

vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('@/utils/uploadValidation', () => ({
  humanizeUploadError: (error: { message?: string; statusCode?: number | string }) =>
    error?.message || `status ${error?.statusCode}`,
}))

import {
  TUS_THRESHOLD_BYTES,
  forgetResumableUploads,
  resetStorageUploads,
  startStorageUpload,
  storedResumableUploads,
} from '@/services/uploads/storageUpload'
import { resetTransfers } from '@/services/transfers'

const TUS = 'http://localhost:54321/storage/v1/upload/resumable'
const UPLOAD_ID = 'bWVzc2FnZV9tZWRpYS91L3gvYS5iaW4vdjE'
const MP4 = new Uint8Array(readFileSync(resolve(__dirname, '../../../../tests/fixtures/media-metadata/gps.mp4')))

class FakeXHR {
  static all: FakeXHR[] = []
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown = null
  status = 0
  responseText = ''
  responseHeaders: Record<string, string> = {}
  upload = { onprogress: null, onload: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  constructor() { FakeXHR.all.push(this) }
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader(name: string, value: string) { this.headers[name] = value }
  send(body: unknown) { this.body = body }
  abort() { this.onabort?.() }
  getResponseHeader(name: string) {
    const key = Object.keys(this.responseHeaders).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? this.responseHeaders[key] : null
  }
  answer(status: number, headers: Record<string, string> = {}) {
    this.status = status
    this.responseHeaders = headers
    this.onload?.()
  }
}

const last = () => FakeXHR.all[FakeXHR.all.length - 1]
const started: Array<{ abort(): void }> = []
function start(options: Parameters<typeof startStorageUpload>[0]) {
  const upload = startStorageUpload(options)
  started.push(upload)
  return upload
}

async function requests(n: number) {
  for (let i = 0; i < 50 && FakeXHR.all.length < n; i++) await flushPromises()
  expect(FakeXHR.all.length).toBeGreaterThanOrEqual(n)
}

/**
 * gps.mp4 (moov/udta/©xyz) followed by a free box that takes it over TUS_THRESHOLD_BYTES.
 * Stripping turns udta into a free box of the same size: name, size and lastModified match.
 */
function movie(): File {
  const pad = new Uint8Array(TUS_THRESHOLD_BYTES)
  new DataView(pad.buffer).setUint32(0, pad.length)
  pad.set([0x66, 0x72, 0x65, 0x65], 4)
  return new File([MP4, pad], 'clip.mp4', { type: 'video/mp4', lastModified: 1_700_000_000_000 })
}

beforeEach(() => {
  FakeXHR.all = []
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
  vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: { access_token: 'user-token' } }, error: null } as never)
  resetStorageUploads()
  resetTransfers()
  forgetResumableUploads()
})

afterEach(async () => {
  started.splice(0).forEach((upload) => upload.abort())
  await flushPromises()
  vi.unstubAllGlobals()
})

describe('resuming and photo details', () => {
  for (const [first, second] of [[true, false], [false, true]] as const) {
    it(`does not continue an upload ${first ? 'with' : 'without'} details by one ${second ? 'with' : 'without'} them`, async () => {
      start({ bucket: 'message_media', path: 'c/r/u/one.mp4', file: movie(), resumeKey: 'c/r/u', keepMetadata: first })
      await requests(1)
      expect(last()).toMatchObject({ method: 'POST', url: TUS })
      last().answer(201, { Location: `${TUS}/${UPLOAD_ID}` })
      await requests(2)
      expect(Object.values(storedResumableUploads())).toEqual([expect.objectContaining({ id: UPLOAD_ID })])

      // The page goes away; the same file is picked again with the other choice.
      FakeXHR.all = []
      resetStorageUploads()
      start({ bucket: 'message_media', path: 'c/r/u/two.mp4', file: movie(), resumeKey: 'c/r/u', keepMetadata: second })
      await requests(1)
      expect(last()).toMatchObject({ method: 'POST', url: TUS })
    })
  }

  it('continues an upload by one with the same choice', async () => {
    start({ bucket: 'message_media', path: 'c/r/u/one.mp4', file: movie(), resumeKey: 'c/r/u' })
    await requests(1)
    last().answer(201, { Location: `${TUS}/${UPLOAD_ID}` })
    await requests(2)
    FakeXHR.all = []
    resetStorageUploads()
    start({ bucket: 'message_media', path: 'c/r/u/two.mp4', file: movie(), resumeKey: 'c/r/u' })
    await requests(1)
    expect(last()).toMatchObject({ method: 'HEAD', url: `${TUS}/${UPLOAD_ID}` })
  })
})

describe('audio', () => {
  it('sends an M4A with its tags', async () => {
    const m4a = MP4.slice()
    m4a.set([0x4d, 0x34, 0x41, 0x20], 8) // ftyp major brand 'M4A '
    const upload = start({ bucket: 'user_media', path: 'u/x/song.m4a', file: new File([m4a], 'song.m4a', { type: 'audio/mp4' }) })
    await requests(1)
    const sent = (last().body as FormData).get('') as File
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(m4a)
    upload.abort()
  })
})
