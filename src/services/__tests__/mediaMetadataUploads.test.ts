import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { supabase } from '@/supabase'

// Every upload path removes photo metadata unless the upload keeps it: the shared storage upload
// (posts, server icons, soundboard), message_media uploads (chat, DMs, threads, Drive) with their
// Drive hash taken over the bytes stored, and profile/server/emoji images however small.

vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('@/utils/uploadValidation', () => ({
  validateImageUpload: vi.fn(async () => null),
  getBucketLimits: vi.fn(async () => ({ maxBytes: 0, allowedMime: null, label: 'file' })),
  humanizeUploadError: (error: { message?: string }) => error?.message ?? 'error',
}))
const hashed: Blob[] = []
const findDriveFilesByHash = vi.fn(async (_hash: string) => [] as unknown[])
vi.mock('@/services/drive/driveService', () => ({
  driveAvailable: async () => true,
  findDriveFilesByHash: (hash: string) => findDriveFilesByHash(hash),
  isDriveHashBlocked: async () => false,
  sha256OfBlob: async (blob: Blob) => {
    hashed.push(blob)
    return `hash-${blob.size}`
  },
}))

import { startStorageUpload } from '@/services/uploads/storageUpload'
import { startMessageMediaUpload } from '@/services/messageMediaUpload'
import { prepareImageUpload, readJpegOrientation } from '@/utils/imageResize'

const JPEG = readFileSync(resolve(__dirname, '../../../tests/fixtures/media-metadata/gps-rotated.jpg'))
const PATH = 'c/66666666-0000-4000-8000-000000000006/aaaaaaaa-0000-4000-8000-000000000001/photo.jpg'

const photo = () => new File([JPEG], 'photo.jpg', { type: 'image/jpeg', lastModified: 1_700_000_000_000 })
const latin1 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('latin1')
const hasDetails = (text: string) => text.includes('HarmonyCam') || text.includes('GPSLatitude') || text.includes('Tokyo')

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

/** Bytes of the file the last request carries (storage-js form field ''). */
async function sentBytes(): Promise<string> {
  for (let i = 0; i < 50 && !FakeXHR.last?.body; i++) await flushPromises()
  const file = FakeXHR.last!.body!.get('') as File
  return latin1(await file.arrayBuffer())
}

beforeEach(() => {
  FakeXHR.last = null
  hashed.length = 0
  findDriveFilesByHash.mockClear()
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: { access_token: 't' } }, error: null } as never)
  vi.mocked(supabase.storage.from).mockReturnValue({
    createSignedUrl: vi.fn(async (path: string) => ({ data: { signedUrl: `https://signed/${path}` }, error: null })),
  } as never)
})

afterEach(() => vi.unstubAllGlobals())

describe('shared storage upload', () => {
  it('sends a photo without its metadata by default', async () => {
    expect(hasDetails(latin1(JPEG))).toBe(true)
    const upload = startStorageUpload({ bucket: 'user_media', path: 'u/posts/a.jpg', file: photo() })
    const sent = await sentBytes()
    expect(hasDetails(sent)).toBe(false)
    expect(readJpegOrientation(new Uint8Array(Buffer.from(sent, 'latin1')))).toBe(6)
    expect(upload.state.total).toBe(sent.length)
    upload.abort()
  })

  it('sends the photo as picked when it keeps its metadata', async () => {
    const upload = startStorageUpload({ bucket: 'user_media', path: 'u/posts/a.jpg', file: photo(), keepMetadata: true })
    expect(await sentBytes()).toBe(latin1(JPEG))
    upload.abort()
  })
})

describe('message media upload', () => {
  it('hashes, looks up and sends the stripped bytes', async () => {
    const upload = startMessageMediaUpload(PATH, photo(), { name: 'photo.jpg' })
    const sent = await sentBytes()
    expect(hasDetails(sent)).toBe(false)
    expect(hashed).toHaveLength(1)
    expect(latin1(await hashed[0].arrayBuffer())).toBe(sent)
    expect(findDriveFilesByHash).toHaveBeenCalledWith(`hash-${sent.length}`)
    expect(JSON.parse(String(FakeXHR.last!.body!.get('metadata')))).toMatchObject({ sha256: `hash-${sent.length}` })
    upload.abort()
  })

  it('hashes and sends the original with keepMetadata', async () => {
    const upload = startMessageMediaUpload(PATH, photo(), { name: 'photo.jpg', keepMetadata: true })
    expect(await sentBytes()).toBe(latin1(JPEG))
    expect(hashed[0].size).toBe(JPEG.length)
    upload.abort()
  })

  it('does not take a kept original for the stripped file in Drive', async () => {
    findDriveFilesByHash.mockResolvedValueOnce([{ bucket: 'message_media', path: 'u/x/old.jpg', state: 'drive', size_bytes: JPEG.length }])
    const upload = startMessageMediaUpload(PATH, photo(), { name: 'photo.jpg' })
    expect(hasDetails(await sentBytes())).toBe(false)
    upload.abort()
  })
})

describe('Drive record of photo details', () => {
  const metadata = () => JSON.parse(String(FakeXHR.last!.body!.get('metadata')))

  it('records a stripped photo as removed, without location', async () => {
    const upload = startMessageMediaUpload(PATH, photo(), { name: 'photo.jpg' })
    await sentBytes()
    expect(metadata()).toMatchObject({ details: 'removed' })
    expect(metadata()).not.toHaveProperty('location')
    upload.abort()
  })

  it('records a kept photo with its location', async () => {
    const upload = startMessageMediaUpload(PATH, photo(), { name: 'photo.jpg', keepMetadata: true })
    await sentBytes()
    expect(metadata()).toMatchObject({ details: 'kept', location: true })
    upload.abort()
  })

  it('records none for a photo without details, and nothing for other files', async () => {
    const png = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])], 'a.png', { type: 'image/png' })
    let upload = startMessageMediaUpload(PATH, png, { name: 'a.png' })
    await sentBytes()
    expect(metadata()).toMatchObject({ details: 'none' })
    upload.abort()
    FakeXHR.last = null
    upload = startMessageMediaUpload(PATH, new File(['notes'], 'a.txt', { type: 'text/plain' }), { name: 'a.txt' })
    await sentBytes()
    expect(metadata()).not.toHaveProperty('details')
    upload.abort()
  })

  it('uploads a stored object fetched when the upload starts, stripped', async () => {
    const fetchStored = vi.fn(async () => photo())
    const upload = startMessageMediaUpload(PATH, { name: 'photo.jpg', size: JPEG.length, fetch: fetchStored }, { name: 'photo.jpg' })
    expect(upload.state.total).toBe(JPEG.length)
    expect(hasDetails(await sentBytes())).toBe(false)
    expect(fetchStored).toHaveBeenCalledTimes(1)
    upload.abort()
  })
})

describe('profile, server and emoji images', () => {
  it('strips a small photo the bucket accepts as is', async () => {
    const prepared = await prepareImageUpload(photo(), 'avatar', { maxBytes: 5 * 1024 * 1024, allowedMime: ['image/jpeg'] })
    expect(prepared.reencoded).toBe(false)
    const bytes = new Uint8Array(await prepared.file.arrayBuffer())
    expect(hasDetails(latin1(bytes))).toBe(false)
    expect(readJpegOrientation(bytes)).toBe(6)
    expect(prepared.file.name).toBe('photo.jpg')
    expect(prepared.contentType).toBe('image/jpeg')
  })
})
