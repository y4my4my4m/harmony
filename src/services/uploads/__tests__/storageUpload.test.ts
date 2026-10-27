import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { supabase } from '@/supabase'

// The shared storage upload: one request up to TUS_THRESHOLD_BYTES, storage's TUS endpoint above
// it, progress from the request body, a PATCH resumed from the offset HEAD reports, an upload
// continued after a reload from its stored id, and uploads that outlive the page that started them.

vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('@/utils/uploadValidation', () => ({
  humanizeUploadError: (error: { message?: string; statusCode?: number | string }) =>
    error?.message || `status ${error?.statusCode}`,
}))

import {
  TUS_CHUNK_BYTES,
  TUS_MIN_PART_BYTES,
  TUS_RETRY_DELAYS_MS,
  TUS_THRESHOLD_BYTES,
  UploadAbortedError,
  forgetResumableUploads,
  resetStorageUploads,
  startStorageUpload,
  storedResumableUploads,
  tusUploadId,
  unevenPart,
  uploadStorageObject,
} from '@/services/uploads/storageUpload'
import { TRANSFER_SHOW_DELAY_MS, resetTransfers, transfers } from '@/services/transfers'

const BASE = 'http://localhost:54321'
const TUS = `${BASE}/storage/v1/upload/resumable`
const UPLOAD_ID = 'bWVzc2FnZV9tZWRpYS91L3gvYS5iaW4vdjE'
const SECOND_ID = 'bWVzc2FnZV9tZWRpYS91L3gvYS5iaW4vdjI'

class FakeXHR {
  static all: FakeXHR[] = []
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown = null
  status = 0
  responseText = ''
  responseHeaders: Record<string, string> = {}
  upload: { onprogress: ((event: Partial<ProgressEvent>) => void) | null; onload: (() => void) | null } = { onprogress: null, onload: null }
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
  answer(status: number, headers: Record<string, string> = {}, text = '') {
    this.status = status
    this.responseHeaders = headers
    this.responseText = text
    this.onload?.()
  }
  bodySize(): number {
    return this.body instanceof Blob ? this.body.size : -1
  }
}

const last = () => FakeXHR.all[FakeXHR.all.length - 1]
const started: Array<{ abort(): void }> = []
function start(options: Parameters<typeof startStorageUpload>[0]) {
  const upload = startStorageUpload(options)
  started.push(upload)
  return upload
}
const sent = (method: string) => FakeXHR.all.filter((x) => x.method === method)

/** Waits until the request count reaches `n`. */
async function requests(n: number) {
  for (let i = 0; i < 50 && FakeXHR.all.length < n; i++) await flushPromises()
  expect(FakeXHR.all.length).toBeGreaterThanOrEqual(n)
}

function bigFile(bytes: number, name = 'big.bin', lastModified = 1_700_000_000_000): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/zip', lastModified })
}

function decodeMetadata(header: string): Record<string, string> {
  return Object.fromEntries(header.split(',').map((pair) => {
    const [key, value] = pair.split(' ')
    return [key, new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)))]
  }))
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
  // Termination requests go out on the stubbed fetch.
  await flushPromises()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('one-request uploads', () => {
  it('posts the file as storage-js does and reports progress from the request body', async () => {
    const file = new File(['emoji bytes'], 'wave.png', { type: 'image/png' })
    const onProgress = vi.fn()
    const upload = start({ bucket: 'emojis', path: 's/u/wave.png', file, cacheControl: '31536000', onProgress })
    await requests(1)

    const xhr = last()
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe(`${BASE}/storage/v1/object/emojis/s/u/wave.png`)
    expect(xhr.headers).toEqual({ Authorization: 'Bearer user-token', apikey: 'test-anon-key', 'x-upsert': 'false' })
    expect((xhr.body as FormData).get('cacheControl')).toBe('31536000')

    // The body is larger than the file: the form fields travel with it.
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 200 })
    expect(upload.state).toMatchObject({ status: 'uploading', transport: 'multipart' })
    expect(upload.state.loaded).toBe(Math.round(11 / 4))
    expect(upload.state.progress).toBe(0.25)
    expect(onProgress).toHaveBeenLastCalledWith(upload.state.progress)

    xhr.answer(200)
    await expect(upload.result).resolves.toEqual({ path: 's/u/wave.png' })
    expect(upload.state).toMatchObject({ status: 'completed', progress: 1 })
  })

  it('answers as supabase-js upload, with storage message and statusCode on a refusal', async () => {
    const pending = uploadStorageObject('soundboard', 's/x.mp3', new File(['x'], 'x.mp3'))
    await requests(1)
    last().answer(400, {}, JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }))
    const { data, error } = await pending
    expect(data).toBeNull()
    expect(error).toMatchObject({ message: 'new row violates row-level security policy', statusCode: '403', status: 400 })
  })
})

describe('threshold', () => {
  it('sends a file of exactly the threshold in one request and a larger one through TUS', async () => {
    const atLimit = start({ bucket: 'message_media', path: 'u/x/a.bin', file: bigFile(TUS_THRESHOLD_BYTES) })
    await requests(1)
    expect(last().url).toBe(`${BASE}/storage/v1/object/message_media/u/x/a.bin`)
    last().answer(200)
    await atLimit.result

    const over = start({
      bucket: 'message_media',
      path: 'u/x/b.bin',
      file: bigFile(TUS_THRESHOLD_BYTES + 1, 'amogus ünï "q".zip'),
      metadata: { name: 'amogus ünï "q".zip', sha256: 'ab' },
    })
    await requests(2)
    const create = last()
    expect(create.method).toBe('POST')
    expect(create.url).toBe(TUS)
    expect(create.headers).toMatchObject({
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(TUS_THRESHOLD_BYTES + 1),
      Authorization: 'Bearer user-token',
      'x-upsert': 'false',
    })
    expect(decodeMetadata(create.headers['Upload-Metadata'])).toEqual({
      bucketName: 'message_media',
      objectName: 'u/x/b.bin',
      contentType: 'application/zip',
      cacheControl: '3600',
      metadata: JSON.stringify({ name: 'amogus ünï "q".zip', sha256: 'ab' }),
    })
    // Location as storage builds it behind a proxy: another origin and port; the id is kept.
    create.answer(201, { Location: `http://localhost:8000/upload/resumable/${UPLOAD_ID}` })
    await requests(3)
    const patch = last()
    expect(patch.method).toBe('PATCH')
    expect(patch.url).toBe(`${TUS}/${UPLOAD_ID}`)
    expect(patch.headers).toMatchObject({ 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' })
    expect(patch.bodySize()).toBe(TUS_CHUNK_BYTES)
    patch.upload.onprogress?.({ lengthComputable: true, loaded: TUS_CHUNK_BYTES / 2, total: TUS_CHUNK_BYTES })
    expect(over.state).toMatchObject({ transport: 'tus', loaded: TUS_CHUNK_BYTES / 2 })
    patch.answer(204, { 'Upload-Offset': String(TUS_CHUNK_BYTES) })
    await requests(4)
    expect(last().headers['Upload-Offset']).toBe(String(TUS_CHUNK_BYTES))
    expect(last().bodySize()).toBe(1)
    last().answer(204, { 'Upload-Offset': String(TUS_THRESHOLD_BYTES + 1) })
    await expect(over.result).resolves.toEqual({ path: 'u/x/b.bin' })
  })

  it('sends in one request when the endpoint is absent or its Location unreadable', async () => {
    const upload = start({ bucket: 'message_media', path: 'u/x/c.bin', file: bigFile(TUS_THRESHOLD_BYTES + 10) })
    await requests(1)
    last().answer(201, {})
    await requests(2)
    expect(last().url).toBe(`${BASE}/storage/v1/object/message_media/u/x/c.bin`)
    last().answer(200)
    await expect(upload.result).resolves.toEqual({ path: 'u/x/c.bin' })

    start({ bucket: 'message_media', path: 'u/x/d.bin', file: bigFile(TUS_THRESHOLD_BYTES + 10) })
    await requests(3)
    expect(last().url).toBe(`${BASE}/storage/v1/object/message_media/u/x/d.bin`)
  })

  it('sends one file in one request when its creation gets no answer, and tries TUS again for the next', async () => {
    const first = start({ bucket: 'message_media', path: 'u/x/i.bin', file: bigFile(TUS_THRESHOLD_BYTES + 10) })
    await requests(1)
    last().onerror?.()
    await requests(2)
    expect(last().url).toBe(`${BASE}/storage/v1/object/message_media/u/x/i.bin`)
    last().answer(200)
    await expect(first.result).resolves.toEqual({ path: 'u/x/i.bin' })

    start({ bucket: 'message_media', path: 'u/x/j.bin', file: bigFile(TUS_THRESHOLD_BYTES + 10) })
    await requests(3)
    expect(last().url).toBe(TUS)
  })
})

describe('resuming', () => {
  it('resumes a dropped PATCH from the offset HEAD reports, to the next chunk boundary', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const size = TUS_CHUNK_BYTES * 2 + 100
    const upload = start({ bucket: 'message_media', path: 'u/x/e.bin', file: bigFile(size), label: 'e.bin' })
    await requests(1)
    last().answer(201, { Location: `/storage/v1/upload/resumable/${UPLOAD_ID}` })
    await requests(2)

    // The connection drops mid-chunk; storage kept 3 MiB of it.
    last().upload.onprogress?.({ lengthComputable: true, loaded: 3 * 1024 * 1024, total: TUS_CHUNK_BYTES })
    last().onerror?.()
    await flushPromises()
    expect(upload.state).toMatchObject({ status: 'uploading', reconnecting: true })
    expect(sent('HEAD')).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(TUS_RETRY_DELAYS_MS[0])
    await requests(3)
    expect(last().method).toBe('HEAD')
    last().answer(200, { 'Upload-Offset': String(3 * 1024 * 1024), 'Upload-Length': String(size) })
    await requests(4)
    const resumed = last()
    expect(resumed.method).toBe('PATCH')
    expect(resumed.headers['Upload-Offset']).toBe(String(3 * 1024 * 1024))
    expect(resumed.bodySize()).toBe(TUS_CHUNK_BYTES - 3 * 1024 * 1024)
    resumed.answer(204, { 'Upload-Offset': String(TUS_CHUNK_BYTES) })
    await flushPromises()
    expect(upload.state.reconnecting).toBe(false)

    await requests(5)
    last().answer(204, { 'Upload-Offset': String(TUS_CHUNK_BYTES * 2) })
    await requests(6)
    last().answer(204, { 'Upload-Offset': String(size) })
    await expect(upload.result).resolves.toEqual({ path: 'u/x/e.bin' })
    expect(sent('PATCH').map((x) => x.headers['Upload-Offset'])).toEqual([
      '0', String(3 * 1024 * 1024), String(TUS_CHUNK_BYTES), String(TUS_CHUNK_BYTES * 2),
    ])
  })

  it('completes with an empty PATCH when HEAD shows every byte but the last answer was lost', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const size = TUS_THRESHOLD_BYTES + 5
    const upload = start({ bucket: 'message_media', path: 'u/x/f.bin', file: bigFile(size) })
    await requests(1)
    last().answer(201, { Location: `${TUS}/${UPLOAD_ID}` })
    await requests(2)
    last().answer(204, { 'Upload-Offset': String(TUS_CHUNK_BYTES) })
    await requests(3)
    last().onerror?.()
    await vi.advanceTimersByTimeAsync(TUS_RETRY_DELAYS_MS[0])
    await requests(4)
    last().answer(200, { 'Upload-Offset': String(size), 'Upload-Length': String(size) })
    await requests(5)
    expect(last().method).toBe('PATCH')
    expect(last().headers['Upload-Offset']).toBe(String(size))
    expect(last().bodySize()).toBe(0)
    last().answer(204, { 'Upload-Offset': String(size) })
    await expect(upload.result).resolves.toEqual({ path: 'u/x/f.bin' })
  })

  it('fails on a refusal without retrying, and terminates the upload on abort', async () => {
    const refused = start({ bucket: 'message_media', path: 'u/x/g.bin', file: bigFile(TUS_THRESHOLD_BYTES + 1) })
    await requests(1)
    last().answer(201, { Location: `${TUS}/${UPLOAD_ID}` })
    await requests(2)
    last().answer(413, {}, JSON.stringify({ statusCode: '413', message: 'Payload too large' }))
    await expect(refused.result).rejects.toThrow('Payload too large')
    expect(sent('HEAD')).toHaveLength(0)

    const aborted = start({ bucket: 'message_media', path: 'u/x/h.bin', file: bigFile(TUS_THRESHOLD_BYTES + 1) })
    await requests(3)
    last().answer(201, { Location: `${TUS}/${UPLOAD_ID}` })
    await requests(4)
    aborted.abort()
    await expect(aborted.result).rejects.toBeInstanceOf(UploadAbortedError)
    await flushPromises()
    expect(fetch).toHaveBeenCalledWith(`${TUS}/${UPLOAD_ID}`, expect.objectContaining({ method: 'DELETE' }))
  })

  it('continues an upload interrupted by a reload when the same file is picked again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const size = TUS_CHUNK_BYTES + 50
    const file = bigFile(size, 'video.mp4')
    start({ bucket: 'message_media', path: 'c/r/u/one.mp4', file, resumeKey: 'c/r/u' })
    await requests(1)
    last().answer(201, { Location: `${TUS}/${UPLOAD_ID}` })
    await requests(2)
    last().answer(204, { 'Upload-Offset': String(TUS_CHUNK_BYTES) })
    await requests(3)
    // The page goes away mid-transfer: its requests stop answering; the record stays.
    expect(Object.values(storedResumableUploads())).toEqual([expect.objectContaining({ id: UPLOAD_ID, path: 'c/r/u/one.mp4' })])

    // The reloaded page has no upload in flight.
    FakeXHR.all = []
    resetStorageUploads()
    const again = start({ bucket: 'message_media', path: 'c/r/u/two.mp4', file: bigFile(size, 'video.mp4'), resumeKey: 'c/r/u' })
    await requests(1)
    expect(last().method).toBe('HEAD')
    expect(last().url).toBe(`${TUS}/${UPLOAD_ID}`)
    last().answer(200, { 'Upload-Offset': String(TUS_CHUNK_BYTES), 'Upload-Length': String(size) })
    await requests(2)
    expect(last().method).toBe('PATCH')
    expect(last().headers['Upload-Offset']).toBe(String(TUS_CHUNK_BYTES))
    expect(again.state.progress).toBeCloseTo(TUS_CHUNK_BYTES / size)
    last().answer(204, { 'Upload-Offset': String(size) })
    await expect(again.result).resolves.toEqual({ path: 'c/r/u/one.mp4' })
    expect(sent('POST')).toHaveLength(0)
    expect(storedResumableUploads()).toEqual({})
  })

  it('starts a new upload when a cut PATCH left a short part stored', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const size = TUS_CHUNK_BYTES * 2 + 100
    const short = TUS_MIN_PART_BYTES + 512 * 1024
    const upload = start({ bucket: 'message_media', path: 'u/x/k.bin', file: bigFile(size) })
    await requests(1)
    last().answer(201, { Location: `${TUS}/${UPLOAD_ID}` })
    await requests(2)
    last().upload.onprogress?.({ lengthComputable: true, loaded: short, total: TUS_CHUNK_BYTES })
    last().onerror?.()
    await vi.advanceTimersByTimeAsync(TUS_RETRY_DELAYS_MS[0])
    await requests(3)
    expect(last().method).toBe('HEAD')
    // @tus/s3-store stored the 5.5 MiB as a part; R2 would refuse to complete the upload.
    last().answer(200, { 'Upload-Offset': String(short), 'Upload-Length': String(size) })
    await requests(4)
    await flushPromises()
    expect(fetch).toHaveBeenCalledWith(`${TUS}/${UPLOAD_ID}`, expect.objectContaining({ method: 'DELETE' }))
    expect(last()).toMatchObject({ method: 'POST', url: TUS })
    last().answer(201, { Location: `${TUS}/${SECOND_ID}` })
    await requests(5)
    expect(last()).toMatchObject({ method: 'PATCH', url: `${TUS}/${SECOND_ID}` })
    expect(last().headers['Upload-Offset']).toBe('0')
    expect(last().bodySize()).toBe(TUS_CHUNK_BYTES)
    expect(upload.state.loaded).toBe(0)
    last().answer(204, { 'Upload-Offset': String(TUS_CHUNK_BYTES) })
    await requests(6)
    last().answer(204, { 'Upload-Offset': String(TUS_CHUNK_BYTES * 2) })
    await requests(7)
    last().answer(204, { 'Upload-Offset': String(size) })
    await expect(upload.result).resolves.toEqual({ path: 'u/x/k.bin' })
  })

  it('does not continue a stored upload that holds a short part', async () => {
    const size = TUS_CHUNK_BYTES * 2 + 100
    const short = TUS_CHUNK_BYTES + TUS_MIN_PART_BYTES
    const file = bigFile(size, 'video.mp4')
    start({ bucket: 'message_media', path: 'c/r/u/one.mp4', file, resumeKey: 'c/r/u' })
    await requests(1)
    last().answer(201, { Location: `${TUS}/${UPLOAD_ID}` })
    await requests(2)

    FakeXHR.all = []
    resetStorageUploads()
    const again = start({ bucket: 'message_media', path: 'c/r/u/two.mp4', file: bigFile(size, 'video.mp4'), resumeKey: 'c/r/u' })
    await requests(1)
    expect(last().method).toBe('HEAD')
    last().answer(200, { 'Upload-Offset': String(short), 'Upload-Length': String(size) })
    await requests(2)
    await flushPromises()
    expect(fetch).toHaveBeenCalledWith(`${TUS}/${UPLOAD_ID}`, expect.objectContaining({ method: 'DELETE' }))
    expect(last()).toMatchObject({ method: 'POST', url: TUS })
    expect(decodeMetadata(last().headers['Upload-Metadata']).objectName).toBe('c/r/u/two.mp4')
    last().answer(201, { Location: `${TUS}/${SECOND_ID}` })
    await requests(3)
    expect(last()).toMatchObject({ method: 'PATCH', url: `${TUS}/${SECOND_ID}` })
    expect(last().headers['Upload-Offset']).toBe('0')
    expect(Object.values(storedResumableUploads())).toEqual([expect.objectContaining({ id: SECOND_ID })])
    again.abort()
  })

  it('restarts once when storage refuses to complete, then fails without waiting out the retries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const size = TUS_THRESHOLD_BYTES + 5
    const refused = JSON.stringify({ statusCode: '500', message: 'All non-trailing parts must have the same length.' })
    const upload = start({ bucket: 'message_media', path: 'u/x/l.bin', file: bigFile(size) })
    for (const [n, id] of [[0, UPLOAD_ID], [5, SECOND_ID]] as const) {
      await requests(n + 1)
      expect(last()).toMatchObject({ method: 'POST', url: TUS })
      last().answer(201, { Location: `${TUS}/${id}` })
      await requests(n + 2)
      expect(last().headers['Upload-Offset']).toBe('0')
      last().answer(204, { 'Upload-Offset': String(TUS_CHUNK_BYTES) })
      await requests(n + 3)
      // The PATCH with the last bytes: the parts are stored, completion is refused.
      last().answer(500, {}, refused)
      await vi.advanceTimersByTimeAsync(TUS_RETRY_DELAYS_MS[0])
      await requests(n + 4)
      expect(last().method).toBe('HEAD')
      last().answer(200, { 'Upload-Offset': String(size), 'Upload-Length': String(size) })
      await requests(n + 5)
      expect(last()).toMatchObject({ method: 'PATCH', url: `${TUS}/${id}` })
      expect(last().bodySize()).toBe(0)
      last().answer(500, {}, refused)
      await flushPromises()
      expect(fetch).toHaveBeenCalledWith(`${TUS}/${id}`, expect.objectContaining({ method: 'DELETE' }))
    }
    await expect(upload.result).rejects.toThrow('All non-trailing parts must have the same length.')
    expect(FakeXHR.all).toHaveLength(10)
  })

  it('starts a new upload when HEAD carries no Upload-Offset', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const size = TUS_CHUNK_BYTES * 2 + 100
    const upload = start({ bucket: 'message_media', path: 'u/x/m.bin', file: bigFile(size) })
    await requests(1)
    last().answer(201, { Location: `${TUS}/${UPLOAD_ID}` })
    await requests(2)
    last().answer(204, { 'Upload-Offset': String(TUS_CHUNK_BYTES) })
    await requests(3)
    last().onerror?.()
    await vi.advanceTimersByTimeAsync(TUS_RETRY_DELAYS_MS[0])
    await requests(4)
    expect(last().method).toBe('HEAD')
    // Not exposed to the page, or dropped by a proxy: the offset is unknown, not 0.
    last().answer(200, { 'Upload-Length': String(size) })
    await requests(5)
    await flushPromises()
    expect(fetch).toHaveBeenCalledWith(`${TUS}/${UPLOAD_ID}`, expect.objectContaining({ method: 'DELETE' }))
    expect(last()).toMatchObject({ method: 'POST', url: TUS })
    last().answer(201, { Location: `${TUS}/${SECOND_ID}` })
    await requests(6)
    expect(last()).toMatchObject({ method: 'PATCH', url: `${TUS}/${SECOND_ID}` })
    expect(last().headers['Upload-Offset']).toBe('0')
    expect(sent('PATCH').filter((x) => x.url === `${TUS}/${UPLOAD_ID}`)).toHaveLength(2)
    upload.abort()
  })

  it('gives a second upload of the same file its own TUS upload; cancelling it leaves the first', async () => {
    const size = TUS_CHUNK_BYTES + 50
    const first = start({ bucket: 'message_media', path: 'c/r/u/one.mp4', file: bigFile(size, 'video.mp4'), resumeKey: 'c/r/u' })
    await requests(1)
    last().answer(201, { Location: `${TUS}/${UPLOAD_ID}` })
    await requests(2)
    const firstPatch = last()

    const second = start({ bucket: 'message_media', path: 'c/r/u/two.mp4', file: bigFile(size, 'video.mp4'), resumeKey: 'c/r/u' })
    await requests(3)
    expect(last()).toMatchObject({ method: 'POST', url: TUS })
    last().answer(201, { Location: `${TUS}/${SECOND_ID}` })
    await requests(4)
    expect(last()).toMatchObject({ method: 'PATCH', url: `${TUS}/${SECOND_ID}` })
    second.abort()
    await expect(second.result).rejects.toBeInstanceOf(UploadAbortedError)
    await flushPromises()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(`${TUS}/${SECOND_ID}`, expect.objectContaining({ method: 'DELETE' }))

    firstPatch.answer(204, { 'Upload-Offset': String(TUS_CHUNK_BYTES) })
    await requests(5)
    expect(last()).toMatchObject({ method: 'PATCH', url: `${TUS}/${UPLOAD_ID}` })
    last().answer(204, { 'Upload-Offset': String(size) })
    await expect(first.result).resolves.toEqual({ path: 'c/r/u/one.mp4' })
    expect(storedResumableUploads()).toEqual({})
  })

  it('names a short part by its offset', () => {
    expect(unevenPart(TUS_MIN_PART_BYTES - 1, TUS_CHUNK_BYTES * 3)).toBe(false)
    expect(unevenPart(TUS_MIN_PART_BYTES, TUS_CHUNK_BYTES * 3)).toBe(true)
    expect(unevenPart(TUS_CHUNK_BYTES, TUS_CHUNK_BYTES * 3)).toBe(false)
    expect(unevenPart(TUS_CHUNK_BYTES * 2 + TUS_MIN_PART_BYTES, TUS_CHUNK_BYTES * 3)).toBe(true)
    // The whole file stored: the short part is the last.
    expect(unevenPart(TUS_CHUNK_BYTES + TUS_MIN_PART_BYTES, TUS_CHUNK_BYTES + TUS_MIN_PART_BYTES)).toBe(false)
  })

  it('takes the id from any Location form', () => {
    expect(tusUploadId(`http://localhost/upload/resumable/${UPLOAD_ID}`)).toBe(UPLOAD_ID)
    expect(tusUploadId(`https://db.example/storage/v1/upload/resumable/${UPLOAD_ID}/?x=1`)).toBe(UPLOAD_ID)
    expect(tusUploadId(null)).toBeNull()
    expect(tusUploadId('https://db.example/upload/resumable/bad%20id')).toBeNull()
  })
})

describe('background uploads', () => {
  it('is aborted when sign-out resets the transfers', async () => {
    const upload = start({ bucket: 'emojis', path: 's/u/wave.png', file: new File(['png'], 'wave.png'), label: 'wave.png' })
    await requests(1)
    resetTransfers()
    await expect(upload.result).rejects.toBeInstanceOf(UploadAbortedError)
    expect(upload.state.status).toBe('aborted')
    expect(transfers()).toHaveLength(0)
  })

  it('keeps uploading and listed after the page that started it is left', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let result: Promise<{ data: { path: string } | null }> | null = null
    const Emoji = defineComponent({
      setup() {
        return () => h('button', {
          onClick: () => { result = uploadStorageObject('emojis', 's/u/party.png', new File(['png'], 'party.png'), { label: 'party.png' }) },
        }, 'Upload')
      },
    })
    const Channel = defineComponent({ setup: () => () => h('p', 'channel') })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/settings', component: Emoji }, { path: '/channel', component: Channel }],
    })
    await router.push('/settings')
    const app = mount(defineComponent({ setup: () => () => h(RouterView) }), { global: { plugins: [router] } })
    await router.isReady()
    await app.find('button').trigger('click')
    await requests(1)
    last().upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 3 })

    await router.push('/channel')
    await flushPromises()
    expect(app.text()).toBe('channel')
    await vi.advanceTimersByTimeAsync(TRANSFER_SHOW_DELAY_MS)
    const [entry] = transfers()
    expect(entry).toMatchObject({ name: 'party.png', direction: 'upload', shown: true })
    expect(entry.progress).toMatchObject({ status: 'running', loaded: 1, total: 3 })

    last().answer(200)
    await expect(result!).resolves.toEqual({ data: { path: 's/u/party.png' }, error: null })
    expect(entry.progress.status).toBe('completed')
    app.unmount()
  })
})
