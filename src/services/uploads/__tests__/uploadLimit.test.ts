import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { supabase } from '@/supabase'

// The account's upload limit (get_my_upload_limit): a file over it in message_media or user_media
// fails before its first byte, listed in the transfers indicator with the limit; a refusal from
// storage of a file over the limit as read again says the same; other buckets keep their own.

vi.mock('@/i18n', () => ({
  i18n: { global: { t: (key: string, values?: Record<string, unknown>) => `${key} ${JSON.stringify(values ?? {})}` } },
}))

import {
  UPLOAD_LIMIT_TTL_MS,
  UploadLimitError,
  checkUploadLimit,
  getUploadLimit,
  resetUploadLimit,
} from '@/services/uploads/uploadLimit'
import { resetStorageUploads, startStorageUpload, StorageUploadError } from '@/services/uploads/storageUpload'
import { resetTransfers, transfers } from '@/services/transfers'

class FakeXHR {
  static all: FakeXHR[] = []
  method = ''
  url = ''
  status = 0
  responseText = ''
  upload = { onprogress: null, onload: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  constructor() { FakeXHR.all.push(this) }
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader() {}
  send() {}
  abort() { this.onabort?.() }
  getResponseHeader() { return null }
  answer(status: number, text = '') {
    this.status = status
    this.responseText = text
    this.onload?.()
  }
}

const MiB = 1024 * 1024
const rpc = vi.mocked(supabase.rpc)
const file = (bytes: number, name = 'clip.mp4') => new File([new Uint8Array(bytes)], name, { type: 'video/mp4' })

function signedInAs(id: string | null) {
  vi.mocked(supabase.auth.getSession).mockResolvedValue({
    data: { session: id ? { access_token: 'token', user: { id } } : null },
    error: null,
  } as never)
}

function limitIs(bytes: number | null) {
  rpc.mockImplementation((async (name: string) =>
    name === 'get_my_upload_limit' ? { data: bytes, error: null } : { data: null, error: null }) as never)
}

beforeEach(() => {
  FakeXHR.all = []
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  rpc.mockReset()
  signedInAs('auth-a')
  resetUploadLimit()
  resetStorageUploads()
  resetTransfers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('reading the limit', () => {
  it('reads it once per account and again after the cache expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    limitIs(10 * MiB)
    expect(await getUploadLimit()).toBe(10 * MiB)
    expect(await getUploadLimit()).toBe(10 * MiB)
    expect(rpc).toHaveBeenCalledTimes(1)

    signedInAs('auth-b')
    limitIs(20 * MiB)
    expect(await getUploadLimit()).toBe(20 * MiB)
    expect(rpc).toHaveBeenCalledTimes(2)

    vi.setSystemTime(Date.now() + UPLOAD_LIMIT_TTL_MS + 1)
    limitIs(30 * MiB)
    expect(await getUploadLimit()).toBe(30 * MiB)
    expect(rpc).toHaveBeenCalledTimes(3)
  })

  it('has none signed out, or from a server without the function', async () => {
    signedInAs(null)
    expect(await getUploadLimit()).toBeNull()
    expect(rpc).not.toHaveBeenCalled()

    signedInAs('auth-a')
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not found' } } as never)
    expect(await getUploadLimit()).toBeNull()
    await expect(checkUploadLimit('message_media', file(100 * MiB))).resolves.toBeUndefined()
  })
})

describe('checking a file', () => {
  it('refuses a file over the limit in message_media and user_media, with the limit in the message', async () => {
    limitIs(5 * MiB)
    const refusal = checkUploadLimit('message_media', file(6 * MiB), 'clip.mp4')
    await expect(refusal).rejects.toBeInstanceOf(UploadLimitError)
    await expect(refusal).rejects.toMatchObject({
      size: 6 * MiB,
      limit: 5 * MiB,
      message: 'uploadLimits.tooLarge {"name":"clip.mp4","size":"6 MB","limit":"5 MB"}',
    })
    await expect(checkUploadLimit('user_media', file(6 * MiB))).rejects.toMatchObject({
      message: 'uploadLimits.tooLargeFile {"size":"6 MB","limit":"5 MB"}',
    })
    await expect(checkUploadLimit('message_media', file(5 * MiB))).resolves.toBeUndefined()
  })

  it('leaves buckets with fixed limits alone', async () => {
    limitIs(1)
    await expect(checkUploadLimit('emojis', file(1024))).resolves.toBeUndefined()
    await expect(checkUploadLimit('avatars', file(1024))).resolves.toBeUndefined()
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('uploads', () => {
  it('fails a file over the limit before its first byte and lists it in the transfers', async () => {
    limitIs(2 * MiB)
    const upload = startStorageUpload({ bucket: 'message_media', path: 'u/auth-a/clip.mp4', file: file(3 * MiB), label: 'clip.mp4' })
    await expect(upload.result).rejects.toBeInstanceOf(UploadLimitError)
    expect(FakeXHR.all).toHaveLength(0)
    expect(upload.state).toMatchObject({ status: 'error', error: 'uploadLimits.tooLarge {"name":"clip.mp4","size":"3 MB","limit":"2 MB"}' })
    expect(transfers()).toHaveLength(1)
    expect(transfers()[0]).toMatchObject({ name: 'clip.mp4', shown: true, progress: { status: 'error', error: upload.state.error } })
  })

  it('names the limit when storage refuses a file over a limit lowered after the check', async () => {
    limitIs(4 * MiB)
    const upload = startStorageUpload({ bucket: 'message_media', path: 'u/auth-a/clip.mp4', file: file(3 * MiB), label: 'clip.mp4' })
    for (let i = 0; i < 20 && FakeXHR.all.length < 1; i++) await flushPromises()
    limitIs(2 * MiB)
    FakeXHR.all[0].answer(400, JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }))
    await expect(upload.result).rejects.toMatchObject({ name: 'UploadLimitError', limit: 2 * MiB })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('keeps storage\'s own refusal for a file within the limit', async () => {
    limitIs(4 * MiB)
    const upload = startStorageUpload({ bucket: 'message_media', path: 'u/auth-a/clip.mp4', file: file(3 * MiB), label: 'clip.mp4' })
    for (let i = 0; i < 20 && FakeXHR.all.length < 1; i++) await flushPromises()
    FakeXHR.all[0].answer(400, JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }))
    await expect(upload.result).rejects.toBeInstanceOf(StorageUploadError)
  })
})
