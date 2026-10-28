import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { supabase } from '@/supabase'

// The Drive record of an upload whose details could not be read through: a kept file is recorded
// as kept; a stripped one is not recorded (photo_details NULL), so Drive reads its bytes again
// and reports the details unknown instead of removed.

vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('@/utils/uploadValidation', () => ({
  validateImageUpload: vi.fn(async () => null),
  getBucketLimits: vi.fn(async () => ({ maxBytes: 0, allowedMime: null, label: 'file' })),
  humanizeUploadError: (error: { message?: string }) => error?.message ?? 'error',
}))
vi.mock('@/services/drive/driveService', () => ({
  driveAvailable: async () => true,
  findDriveFilesByHash: async () => [],
  isDriveHashBlocked: async () => false,
  sha256OfBlob: async (blob: Blob) => `hash-${blob.size}`,
}))

import { startMessageMediaUpload } from '@/services/messageMediaUpload'

const PATH = 'c/66666666-0000-4000-8000-000000000006/aaaaaaaa-0000-4000-8000-000000000001/clip.mp4'
const FAST_START = new Uint8Array(readFileSync(resolve(__dirname, '../../../tests/fixtures/media-metadata/gps-faststart.mp4')))

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

async function sentMetadata(): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50 && !FakeXHR.last?.body; i++) await flushPromises()
  return JSON.parse(String(FakeXHR.last!.body!.get('metadata')))
}

/** gps-faststart.mp4 (ftyp 32, moov 909, free 8, mdat 995) with its free box sized 4: unwalkable past moov. */
function brokenMovie(): File {
  const bytes = FAST_START.slice()
  new DataView(bytes.buffer).setUint32(32 + 909, 4)
  return new File([bytes], 'clip.mp4', { type: 'video/mp4' })
}

beforeEach(() => {
  FakeXHR.last = null
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: { access_token: 't' } }, error: null } as never)
  vi.mocked(supabase.storage.from).mockReturnValue({
    createSignedUrl: vi.fn(async (path: string) => ({ data: { signedUrl: `https://signed/${path}` }, error: null })),
  } as never)
})

afterEach(() => vi.unstubAllGlobals())

describe('Drive record of a file with unknown details', () => {
  it('records nothing for a stripped upload', async () => {
    const upload = startMessageMediaUpload(PATH, brokenMovie(), { name: 'clip.mp4' })
    const metadata = await sentMetadata()
    expect(metadata).toHaveProperty('sha256')
    expect(metadata).not.toHaveProperty('details')
    expect(metadata).not.toHaveProperty('location')
    upload.abort()
  })

  it('records a kept upload as kept, with its location', async () => {
    const upload = startMessageMediaUpload(PATH, brokenMovie(), { name: 'clip.mp4', keepMetadata: true })
    expect(await sentMetadata()).toMatchObject({ details: 'kept', location: true })
    upload.abort()
  })
})
