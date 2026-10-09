import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { supabase } from '@/supabase'

vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('@/utils/uploadValidation', () => ({
  validateImageUpload: vi.fn(async (file: File) => (file.size > 10 ? 'too large' : null)),
  humanizeUploadError: (error: { message?: string; statusCode?: number | string }) =>
    error?.message || `status ${error?.statusCode}`,
}))

import {
  UPLOAD_STALL_MS,
  UploadAbortedError,
  forgetMessageMediaUpload,
  messageMediaUploadState,
  startMessageMediaUpload,
} from '@/services/messageMediaUpload'

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
    await expect(upload.result).resolves.toEqual({ path: PATH, url: `https://signed/${PATH}` })
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

  it('fails validation before any request', async () => {
    const upload = startMessageMediaUpload(PATH, new File(['far too many bytes'], 'x.png', { type: 'image/png' }), { validate: true })
    await expect(upload.result).rejects.toThrow('too large')
    expect(FakeXHR.last).toBeNull()

    const svg = startMessageMediaUpload(PATH, new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }), { validate: true })
    await expect(svg.result).rejects.toThrow(/SVG/)
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

  it('fails an upload with no progress for the stall window, however long it runs', async () => {
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

    await expect(upload.result).resolves.toEqual({ path: PATH, url: `https://signed/${PATH}` })
  })
})
