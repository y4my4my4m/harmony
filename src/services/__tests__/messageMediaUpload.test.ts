import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { supabase } from '@/supabase'

vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
const bucket = vi.hoisted(() => ({ allowedMime: null as string[] | null }))
vi.mock('@/utils/uploadValidation', () => ({
  validateUploadSize: vi.fn(async (file: Blob) => (file.size > 10 ? 'too large' : null)),
  getBucketLimits: vi.fn(async () => ({ maxBytes: 0, allowedMime: bucket.allowedMime, label: 'file' })),
  humanizeUploadError: (error: { message?: string; statusCode?: number | string }) =>
    error?.message || `status ${error?.statusCode}`,
}))

import {
  UPLOAD_STALL_MS,
  UploadAbortedError,
  forgetMessageMediaUpload,
  messageMediaUploadState,
  startMessageMediaUpload,
  storedContentType,
} from '@/services/messageMediaUpload'
import { WHOLE_RETRY_DELAY_MS } from '@/services/uploads/storageUpload'

const PATH = 'c/66666666-0000-4000-8000-000000000006/aaaaaaaa-0000-4000-8000-000000000001/x.png'

class FakeXHR {
  static last: FakeXHR | null = null
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: FormData | null = null
  status = 0
  responseText = ''
  upload: { onprogress: ((event: Partial<ProgressEvent>) => void) | null; onload: (() => void) | null } = { onprogress: null, onload: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  constructor() { FakeXHR.last = this }
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader(name: string, value: string) { this.headers[name] = value }
  send(body: FormData) { this.body = body }
  abort() { this.onabort?.() }
}

beforeEach(() => {
  FakeXHR.last = null
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  vi.mocked(supabase.auth.getSession).mockResolvedValue({
    data: { session: { access_token: 'user-token' } },
    error: null,
  } as never)
  vi.mocked(supabase.storage.from).mockReturnValue({
    createSignedUrl: vi.fn(async (path: string) => ({ data: { signedUrl: `https://signed/${path}` }, error: null })),
  } as never)
  forgetMessageMediaUpload(PATH)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('startMessageMediaUpload', () => {
  it('posts the file as storage-js does and reports progress from the request body', async () => {
    const file = new File(['png'], 'x.png', { type: 'image/png' })
    const onProgress = vi.fn()
    const upload = startMessageMediaUpload(PATH, file, { validate: true, onProgress })
    await flushPromises()

    const xhr = FakeXHR.last!
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe(`http://localhost:54321/storage/v1/object/message_media/${PATH}`)
    expect(xhr.headers).toEqual({ Authorization: 'Bearer user-token', apikey: 'test-anon-key', 'x-upsert': 'false' })
    expect(xhr.body?.get('cacheControl')).toBe('3600')
    expect((xhr.body?.get('') as File).name).toBe('x.png')

    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 })
    expect(upload.state).toMatchObject({ status: 'uploading', progress: 0.25 })
    expect(messageMediaUploadState(PATH)?.progress).toBe(0.25)
    expect(onProgress).toHaveBeenLastCalledWith(0.25)

    xhr.status = 200
    xhr.onload?.()
    await expect(upload.result).resolves.toEqual({ path: PATH, url: `https://signed/${PATH}`, contentType: 'image/png' })
    expect(upload.state).toMatchObject({ status: 'completed', progress: 1 })
  })

  it('rejects with the storage error message', async () => {
    const upload = startMessageMediaUpload(PATH, new File(['png'], 'x.png', { type: 'image/png' }))
    await flushPromises()
    const xhr = FakeXHR.last!
    xhr.status = 403
    xhr.responseText = JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' })
    xhr.onload?.()

    await expect(upload.result).rejects.toThrow('new row violates row-level security policy')
    expect(upload.state).toMatchObject({ status: 'error', error: 'new row violates row-level security policy' })
  })

  it('fails the size check before any request', async () => {
    const upload = startMessageMediaUpload(PATH, new File(['far too many bytes'], 'x.png', { type: 'image/png' }), { validate: true })
    await expect(upload.result).rejects.toThrow('too large')
    expect(FakeXHR.last).toBeNull()
  })

  it('takes a type the bucket does not serve, stored as application/octet-stream under its own name', async () => {
    const upload = startMessageMediaUpload(PATH, new File(['PK'], 'app.apk', { type: 'application/vnd.android.package-archive' }), { validate: true })
    await flushPromises()
    const sent = FakeXHR.last!.body?.get('') as File
    expect(sent.type).toBe('application/octet-stream')
    expect(sent.name).toBe('app.apk')
    FakeXHR.last!.status = 200
    FakeXHR.last!.onload?.()
    await expect(upload.result).resolves.toMatchObject({ contentType: 'application/octet-stream' })
  })


  it('aborts the request', async () => {
    const upload = startMessageMediaUpload(PATH, new File(['png'], 'x.png', { type: 'image/png' }))
    await flushPromises()
    upload.abort()

    await expect(upload.result).rejects.toBeInstanceOf(UploadAbortedError)
    expect(upload.state.status).toBe('aborted')
  })

  it('aborts before the request opens', async () => {
    const upload = startMessageMediaUpload(PATH, new File(['png'], 'x.png', { type: 'image/png' }))
    upload.abort()

    await expect(upload.result).rejects.toBeInstanceOf(UploadAbortedError)
    expect(FakeXHR.last).toBeNull()
  })

  it('fails an upload whose request and its one retry each go the stall window without progress', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const upload = startMessageMediaUpload(PATH, new File(['png'], 'x.png', { type: 'image/png' }))
    await flushPromises()
    const xhr = FakeXHR.last!

    for (let sent = 10; sent <= 90; sent += 40) {
      await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1000)
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: sent, total: 100 })
    }
    expect(upload.state.status).toBe('uploading')

    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS)
    expect(upload.state).toMatchObject({ status: 'uploading', reconnecting: true })
    await vi.advanceTimersByTimeAsync(WHOLE_RETRY_DELAY_MS)
    expect(FakeXHR.last).not.toBe(xhr)
    expect(upload.state.reconnecting).toBe(false)

    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS)
    await expect(upload.result).rejects.toThrow('message.upload.stalled')
    expect(upload.state).toMatchObject({ status: 'error', error: 'message.upload.stalled' })
  })

  it('waits the same window for the response once the body is sent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const upload = startMessageMediaUpload(PATH, new File(['png'], 'x.png', { type: 'image/png' }))
    await flushPromises()
    const xhr = FakeXHR.last!
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 })
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1000)
    xhr.upload.onload?.()
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1000)
    xhr.status = 200
    xhr.onload?.()

    await expect(upload.result).resolves.toEqual({ path: PATH, url: `https://signed/${PATH}`, contentType: 'image/png' })
  })
})

describe('storedContentType', () => {
  afterEach(() => { bucket.allowedMime = null })

  const f = (name: string, type: string) => new File(['x'], name, { type })

  it('keeps a type the bucket serves, and stores any other as octet-stream', async () => {
    expect(await storedContentType(f('a.png', 'image/png'))).toBe('image/png')
    expect(await storedContentType(f('a.mp4', 'video/mp4'))).toBe('video/mp4')
    expect(await storedContentType(f('a.ogg', 'audio/ogg; codecs=opus'))).toBe('audio/ogg; codecs=opus')
    expect(await storedContentType(f('a.pdf', 'application/pdf'))).toBe('application/pdf')
    expect(await storedContentType(f('a.apk', 'application/vnd.android.package-archive'))).toBe('application/octet-stream')
    expect(await storedContentType(f('a.exe', 'application/x-msdownload'))).toBe('application/octet-stream')
    expect(await storedContentType(f('a.json', 'application/json'))).toBe('application/octet-stream')
    expect(await storedContentType(f('a.bin', ''))).toBe('application/octet-stream')
  })

  it('stores what a browser would run as octet-stream, whatever the bucket allows', async () => {
    bucket.allowedMime = ['*/*']
    expect(await storedContentType(f('a.html', 'text/html'))).toBe('application/octet-stream')
    expect(await storedContentType(f('a.svg', 'image/svg+xml'))).toBe('application/octet-stream')
    expect(await storedContentType(f('a.xml', 'application/xml'))).toBe('application/octet-stream')
    expect(await storedContentType(f('a.js', 'text/javascript'))).toBe('application/octet-stream')
    expect(await storedContentType(f('page.html', 'text/plain'))).toBe('application/octet-stream')
    expect(await storedContentType(f('a.png', 'image/png'))).toBe('image/png')
  })

  it('follows the instance\'s live bucket list', async () => {
    bucket.allowedMime = ['image/png', 'application/octet-stream']
    expect(await storedContentType(f('a.png', 'image/png'))).toBe('image/png')
    expect(await storedContentType(f('a.mp4', 'video/mp4'))).toBe('application/octet-stream')
  })
})
