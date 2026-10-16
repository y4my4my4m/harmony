import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { supabase } from '@/supabase'

// On an instance with Drive: uploads carry their SHA-256 and name as storage metadata, bytes
// already kept in Drive are sent as that object without an upload, and a refusal of bytes staff
// blocked says so.

vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
const validateImageUpload = vi.fn(async (_file: File, _bucket: string): Promise<string | null> => null)
const getBucketLimits = vi.fn(async () => ({ maxBytes: 0, allowedMime: null, label: 'file' }))
vi.mock('@/utils/uploadValidation', () => ({
  validateImageUpload: (file: File, bucket: string) => validateImageUpload(file, bucket),
  getBucketLimits: () => getBucketLimits(),
  humanizeUploadError: (error: { message?: string }) => error?.message ?? 'error',
}))
const findDriveFilesByHash = vi.fn()
const isDriveHashBlocked = vi.fn()
const driveAvailable = vi.fn(async () => true)
vi.mock('@/services/drive/driveService', () => ({
  driveAvailable: () => driveAvailable(),
  findDriveFilesByHash: (...args: unknown[]) => findDriveFilesByHash(...args),
  isDriveHashBlocked: (...args: unknown[]) => isDriveHashBlocked(...args),
  sha256OfBlob: async () => 'ab'.repeat(32),
}))

import {
  forgetMessageMediaUpload,
  prepareMessageMediaUploads,
  startMessageMediaUpload,
} from '@/services/messageMediaUpload'

const PATH = 'c/66666666-0000-4000-8000-000000000006/aaaaaaaa-0000-4000-8000-000000000001/x.png'
const KEPT = 'c/77777777-0000-4000-8000-000000000007/aaaaaaaa-0000-4000-8000-000000000001/old.png'

class FakeXHR {
  static last: FakeXHR | null = null
  body: FormData | null = null
  status = 0
  responseText = ''
  upload = { onprogress: null, onload: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  constructor() { FakeXHR.last = this }
  open() {}
  setRequestHeader() {}
  send(body: FormData) { this.body = body }
  abort() { this.onabort?.() }
}

beforeEach(() => {
  FakeXHR.last = null
  findDriveFilesByHash.mockReset()
  isDriveHashBlocked.mockReset()
  driveAvailable.mockClear()
  validateImageUpload.mockClear()
  getBucketLimits.mockClear()
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: { access_token: 't' } }, error: null } as never)
  vi.mocked(supabase.storage.from).mockReturnValue({
    createSignedUrl: vi.fn(async (path: string) => ({ data: { signedUrl: `https://signed/${path}` }, error: null })),
  } as never)
  forgetMessageMediaUpload(PATH)
})

afterEach(() => vi.unstubAllGlobals())

describe('Drive uploads', () => {
  it('sends the same bytes kept in Drive as that object, without an upload', async () => {
    findDriveFilesByHash.mockResolvedValue([{ bucket: 'message_media', path: KEPT, state: 'drive', size_bytes: 3 }])
    const upload = startMessageMediaUpload(PATH, new File(['png'], 'x.png', { type: 'image/png' }), { name: 'x.png' })
    await expect(upload.result).resolves.toEqual({ path: KEPT, url: `https://signed/${KEPT}`, reused: true })
    expect(FakeXHR.last).toBeNull()
    expect(findDriveFilesByHash).toHaveBeenCalledWith('ab'.repeat(32))
  })

  it('uploads with SHA-256, name and the temporary flag as metadata', async () => {
    findDriveFilesByHash.mockResolvedValue([])
    startMessageMediaUpload(PATH, new File(['png'], 'x.png', { type: 'image/png' }), { name: 'holiday.png', ephemeral: true })
    await flushPromises()
    expect(JSON.parse(String(FakeXHR.last!.body!.get('metadata')))).toEqual({
      sha256: 'ab'.repeat(32), name: 'holiday.png', ephemeral: true,
    })
  })

  it('leaves the name out for encrypted rooms and skips the lookup when asked to', async () => {
    startMessageMediaUpload(PATH, new File(['png'], 'x.png', { type: 'image/png' }), { reuse: false })
    await flushPromises()
    expect(findDriveFilesByHash).not.toHaveBeenCalled()
    expect(JSON.parse(String(FakeXHR.last!.body!.get('metadata')))).toEqual({ sha256: 'ab'.repeat(32) })
  })

  it('does not reuse a temporary file or one of another size', async () => {
    findDriveFilesByHash.mockResolvedValue([
      { bucket: 'message_media', path: KEPT, state: 'ephemeral', size_bytes: 3 },
      { bucket: 'message_media', path: KEPT, state: 'drive', size_bytes: 99 },
    ])
    startMessageMediaUpload(PATH, new File(['png'], 'x.png', { type: 'image/png' }))
    await flushPromises()
    expect(FakeXHR.last).not.toBeNull()
  })

  it('says blocked bytes were removed by the moderators', async () => {
    findDriveFilesByHash.mockResolvedValue([])
    isDriveHashBlocked.mockResolvedValue(true)
    const upload = startMessageMediaUpload(PATH, new File(['png'], 'x.png', { type: 'image/png' }))
    await flushPromises()
    const xhr = FakeXHR.last!
    xhr.status = 400
    xhr.responseText = JSON.stringify({ statusCode: '403', message: 'new row violates row-level security policy' })
    xhr.onload!()
    await expect(upload.result).rejects.toThrow('drive.errors.blocked')
    expect(isDriveHashBlocked).toHaveBeenCalledWith('ab'.repeat(32))
  })

  it('keeps the storage refusal for bytes nobody blocked', async () => {
    findDriveFilesByHash.mockResolvedValue([])
    isDriveHashBlocked.mockResolvedValue(false)
    const upload = startMessageMediaUpload(PATH, new File(['png'], 'x.png', { type: 'image/png' }))
    await flushPromises()
    const xhr = FakeXHR.last!
    xhr.status = 400
    xhr.responseText = JSON.stringify({ statusCode: '403', message: 'new row violates row-level security policy' })
    xhr.onload!()
    await expect(upload.result).rejects.toThrow('new row violates row-level security policy')
  })

  it('asks for the bucket limits and the Drive probe at once, not one after the other', async () => {
    let releaseValidation!: () => void
    validateImageUpload.mockImplementationOnce(() => new Promise((resolve) => {
      releaseValidation = () => resolve(null)
    }))
    findDriveFilesByHash.mockResolvedValue([])
    startMessageMediaUpload(PATH, new File(['png'], 'x.png', { type: 'image/png' }), { validate: true })
    await flushPromises()
    expect(validateImageUpload).toHaveBeenCalled()
    expect(driveAvailable).toHaveBeenCalled()
    expect(FakeXHR.last).toBeNull()

    releaseValidation()
    await flushPromises()
    expect(FakeXHR.last).not.toBeNull()
  })

  it('the composer starts both once-per-session reads before any file is attached', () => {
    prepareMessageMediaUploads()
    expect(getBucketLimits).toHaveBeenCalledTimes(1)
    expect(driveAvailable).toHaveBeenCalledTimes(1)
  })
})
