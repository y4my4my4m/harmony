import { beforeEach, describe, expect, it, vi } from 'vitest'
import { supabase } from '@/supabase'
import {
  COMPAT_URL_TTL_SECONDS,
  MESSAGE_MEDIA_BUCKET,
  VIEW_URL_TTL_SECONDS,
  attachmentParts,
  ensureMediaPartSources,
  isPrivateMediaPart,
  mediaPartFileName,
  mediaPartSource,
  mediaRoom,
  mediaRoomOfPath,
  messageMediaPath,
  messageMediaPathsIn,
  placeUploadInRoom,
  reportMediaPartError,
  resetMediaPartSources,
  resolveMediaPartUrl,
  storageObjectFromUrl,
  uploadMessageMedia,
} from '@/services/privateMedia'

const CHANNEL = '66666666-0000-4000-8000-000000000006'
const OTHER_CHANNEL = '66666666-0000-4000-8000-000000000007'
const CONVERSATION = '77777777-0000-4000-8000-000000000007'
const UID = 'aaaaaaaa-0000-4000-8000-000000000001'

const signed = (path: string, tag = 'view') => `http://localhost:54321/storage/v1/object/sign/message_media/${path}?token=${tag}`

interface BucketMock {
  createSignedUrls: ReturnType<typeof vi.fn>
  createSignedUrl: ReturnType<typeof vi.fn>
  upload: ReturnType<typeof vi.fn>
  copy: ReturnType<typeof vi.fn>
}

function mockBucket(overrides: Partial<BucketMock> = {}): BucketMock {
  const bucket: BucketMock = {
    createSignedUrls: vi.fn(async (paths: string[]) => ({
      data: paths.map((path) => ({ path, signedUrl: signed(path), error: null })),
      error: null,
    })),
    createSignedUrl: vi.fn(async (path: string, _ttl: number, options?: { transform?: unknown }) => ({
      data: { signedUrl: signed(path, options?.transform ? 'thumb' : 'compat') },
      error: null,
    })),
    upload: vi.fn(async (path: string) => ({ data: { path }, error: null })),
    copy: vi.fn(async (_from: string, to: string) => ({ data: { path: to }, error: null })),
    ...overrides,
  }
  vi.mocked(supabase.storage.from).mockReturnValue(bucket as never)
  return bucket
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  resetMediaPartSources()
  vi.mocked(supabase.storage.from).mockReset()
})

describe('room prefixes', () => {
  it('names DMs by conversation and channels and threads by channel', () => {
    expect(mediaRoom({ conversationId: CONVERSATION, channelId: CHANNEL })).toBe(`d/${CONVERSATION}`)
    expect(mediaRoom({ channelId: CHANNEL.toUpperCase() })).toBe(`c/${CHANNEL}`)
    expect(mediaRoom({ channelId: 'general' })).toBeNull()
    expect(mediaRoom({})).toBeNull()
  })

  it('reads the room of an object name', () => {
    expect(mediaRoomOfPath(`c/${CHANNEL}/${UID}/a.png`)).toBe(`c/${CHANNEL}`)
    expect(mediaRoomOfPath(`d/${CONVERSATION}/${UID}/a.png`)).toBe(`d/${CONVERSATION}`)
    expect(mediaRoomOfPath(`${UID}/a.png`)).toBeNull()
    expect(mediaRoomOfPath(`x/${CHANNEL}/a.png`)).toBeNull()
    expect(mediaRoomOfPath(undefined)).toBeNull()
  })

  it('builds upload names under the room and the uploader', () => {
    expect(messageMediaPath(`c/${CHANNEL}`, UID, 'Photo.JPG')).toMatch(
      new RegExp(`^c/${CHANNEL}/${UID}/[0-9a-f-]{36}\\.jpg$`))
    expect(messageMediaPath(`c/${CHANNEL}`, UID, 'README')).toMatch(/\.bin$/)
    expect(messageMediaPath(`c/${CHANNEL}`, UID, 'evil.p/hp')).toMatch(/\.bin$/)
  })

  it('lists the objects of the room that file parts name, sorted and distinct', () => {
    const b = `c/${CHANNEL}/${UID}/b.png`
    const a = `c/${CHANNEL}/${UID}/a.png`
    expect(messageMediaPathsIn([
      { type: 'text', text: 'x' },
      { type: 'file', url: '', path: b },
      { type: 'file', url: '', path: a },
      { type: 'file', url: '', path: b },
      { type: 'file', url: '', path: `c/${OTHER_CHANNEL}/${UID}/c.png` },
      { type: 'file', url: 'https://cdn.example/legacy.png' },
      { type: 'image', path: `c/${CHANNEL}/${UID}/not-a-file-part.png` },
    ], `c/${CHANNEL}`)).toEqual([a, b])
    expect(messageMediaPathsIn([{ type: 'file', url: '', path: a }], null)).toEqual([])
    expect(messageMediaPathsIn([{ type: 'text', text: 'x' }], `c/${CHANNEL}`)).toEqual([])
  })

  it('tells private parts from legacy ones', () => {
    expect(isPrivateMediaPart({ type: 'file', url: 'x', path: `c/${CHANNEL}/${UID}/a.png` })).toBe(true)
    expect(isPrivateMediaPart({ type: 'file', url: 'https://cdn.example/a.png' })).toBe(false)
    expect(isPrivateMediaPart({ type: 'file', url: 'x', path: `${UID}/a.png` })).toBe(false)
    expect(isPrivateMediaPart(null)).toBe(false)
  })

  it('parses storage object URLs', () => {
    expect(storageObjectFromUrl(signed(`c/${CHANNEL}/${UID}/a%20b.png`))).toEqual({
      bucket: MESSAGE_MEDIA_BUCKET, path: `c/${CHANNEL}/${UID}/a b.png`,
    })
    expect(storageObjectFromUrl('https://db.example/storage/v1/object/public/user_media/u/a.png')).toEqual({
      bucket: 'user_media', path: 'u/a.png',
    })
    expect(storageObjectFromUrl('https://cdn.example/a.png')).toBeNull()
  })

  it('names files by fileName, then by path, never by token', () => {
    expect(mediaPartFileName({ url: signed('c/x/y/z.pdf'), path: `c/${CHANNEL}/${UID}/z.pdf`, fileName: 'Report.pdf' })).toBe('Report.pdf')
    expect(mediaPartFileName({ url: signed(`c/${CHANNEL}/${UID}/z.pdf`), path: `c/${CHANNEL}/${UID}/z.pdf` })).toBe('z.pdf')
    expect(mediaPartFileName({ url: 'https://cdn.example/a%20b.txt?x=1' })).toBe('a b.txt')
  })
})

describe('mediaPartSource', () => {
  it('passes legacy URLs through', () => {
    const bucket = mockBucket()
    expect(mediaPartSource({ url: 'https://cdn.example/a.gif' })).toBe('https://cdn.example/a.gif')
    expect(bucket.createSignedUrls).not.toHaveBeenCalled()
  })

  it('signs the paths read in one tick with one request', async () => {
    const bucket = mockBucket()
    const a = { url: signed('a', 'compat'), path: `c/${CHANNEL}/${UID}/a.mp4` }
    const b = { url: signed('b', 'compat'), path: `d/${CONVERSATION}/${UID}/b.webm` }

    expect(mediaPartSource(a)).toBeUndefined()
    expect(mediaPartSource(b)).toBeUndefined()
    await tick()
    await tick()

    expect(bucket.createSignedUrls).toHaveBeenCalledTimes(1)
    expect(bucket.createSignedUrls).toHaveBeenCalledWith([a.path, b.path], VIEW_URL_TTL_SECONDS)
    expect(mediaPartSource(a)).toBe(signed(a.path))
    expect(mediaPartSource(b)).toBe(signed(b.path))

    mediaPartSource(a)
    await tick()
    expect(bucket.createSignedUrls).toHaveBeenCalledTimes(1)
  })

  it('falls back to the part URL when signing is refused', async () => {
    mockBucket({
      createSignedUrls: vi.fn(async (paths: string[]) => ({
        data: paths.map((path) => ({ path, signedUrl: null, error: 'Either the object does not exist or you do not have access to it' })),
        error: null,
      })),
    })
    const part = { url: 'https://db.example/storage/v1/object/sign/message_media/x?token=old', path: `c/${CHANNEL}/${UID}/a.mp4` }
    await ensureMediaPartSources([part])
    expect(mediaPartSource(part)).toBe(part.url)
  })

  it('renders static images through a signed thumbnail and others as originals', async () => {
    const bucket = mockBucket()
    const jpg = { url: 'x', path: `c/${CHANNEL}/${UID}/a.jpg` }
    const gif = { url: 'y', path: `c/${CHANNEL}/${UID}/b.gif` }
    await ensureMediaPartSources([jpg, gif], 'thumbnail')

    expect(bucket.createSignedUrl).toHaveBeenCalledWith(jpg.path, VIEW_URL_TTL_SECONDS, {
      transform: { width: 1024, height: 1024, resize: 'contain', quality: 80 },
    })
    expect(mediaPartSource(jpg, 'thumbnail')).toBe(signed(jpg.path, 'thumb'))
    expect(mediaPartSource(gif, 'thumbnail')).toBe(signed(gif.path))
  })

  it('falls back from a failed thumbnail to the original', async () => {
    mockBucket()
    const jpg = { url: 'x', path: `c/${CHANNEL}/${UID}/a.jpg` }
    await ensureMediaPartSources([jpg], 'thumbnail')
    reportMediaPartError(jpg, 'thumbnail')
    expect(mediaPartSource(jpg, 'thumbnail')).toBeUndefined()
    await tick()
    await tick()
    expect(mediaPartSource(jpg, 'thumbnail')).toBe(signed(jpg.path))
  })

  it('re-signs an original that failed to load, once per interval', async () => {
    const bucket = mockBucket()
    const part = { url: 'x', path: `c/${CHANNEL}/${UID}/a.mp4` }
    await ensureMediaPartSources([part])
    expect(bucket.createSignedUrls).toHaveBeenCalledTimes(1)

    reportMediaPartError(part)
    await ensureMediaPartSources([part])
    expect(bucket.createSignedUrls).toHaveBeenCalledTimes(2)

    reportMediaPartError(part)
    await ensureMediaPartSources([part])
    expect(bucket.createSignedUrls).toHaveBeenCalledTimes(2)
    expect(mediaPartSource(part)).toBe(signed(part.path))
  })

  it('resolves action URLs on demand', async () => {
    mockBucket()
    const part = { url: 'x', path: `d/${CONVERSATION}/${UID}/a.pdf` }
    await expect(resolveMediaPartUrl(part)).resolves.toBe(signed(part.path))
    await expect(resolveMediaPartUrl({ url: 'https://cdn.example/a.pdf' })).resolves.toBe('https://cdn.example/a.pdf')
    await expect(resolveMediaPartUrl({ url: 'javascript:alert(1)' })).resolves.toBeUndefined()
  })
})

describe('uploads', () => {
  it('uploads under the room and carries a seven-day URL', async () => {
    const bucket = mockBucket()
    const file = new File(['x'], 'cat.png', { type: 'image/png' })
    const uploaded = await uploadMessageMedia(`c/${CHANNEL}`, UID, file, { fileName: file.name })

    expect(supabase.storage.from).toHaveBeenCalledWith(MESSAGE_MEDIA_BUCKET)
    expect(uploaded.path).toMatch(new RegExp(`^c/${CHANNEL}/${UID}/[0-9a-f-]{36}\\.png$`))
    expect(bucket.upload).toHaveBeenCalledWith(uploaded.path, file, { upsert: false })
    expect(bucket.createSignedUrl).toHaveBeenCalledWith(uploaded.path, COMPAT_URL_TTL_SECONDS)
    expect(uploaded.url).toBe(signed(uploaded.path, 'compat'))
    // The uploader's own URL serves the first render.
    expect(mediaPartSource({ url: uploaded.url, path: uploaded.path })).toBe(uploaded.url)
  })

  it('refuses an upload without a room', async () => {
    mockBucket()
    await expect(uploadMessageMedia('general', UID, new Blob(['x']))).rejects.toThrow(/channel or conversation/)
  })

  it('carries an unsigned reference when the compat URL cannot be signed', async () => {
    mockBucket({ createSignedUrl: vi.fn(async () => ({ data: null, error: new Error('nope') })) })
    const uploaded = await uploadMessageMedia(`d/${CONVERSATION}`, UID, new Blob(['x']), { fileName: 'a.txt' })
    expect(uploaded.url).toBe(`http://localhost:54321/storage/v1/object/authenticated/message_media/${uploaded.path}`)
  })

  it('copies an upload into the room the message is sent to', async () => {
    const bucket = mockBucket()
    const upload = { path: `c/${CHANNEL}/${UID}/f.png`, url: 'u' }
    await expect(placeUploadInRoom(upload, `c/${CHANNEL}`)).resolves.toBe(upload)
    expect(bucket.copy).not.toHaveBeenCalled()

    const moved = await placeUploadInRoom(upload, `c/${OTHER_CHANNEL}`)
    expect(bucket.copy).toHaveBeenCalledWith(upload.path, `c/${OTHER_CHANNEL}/${UID}/f.png`)
    expect(moved).toEqual({ path: `c/${OTHER_CHANNEL}/${UID}/f.png`, url: signed(`c/${OTHER_CHANNEL}/${UID}/f.png`, 'compat') })
  })

  it('builds file parts from completed uploads', async () => {
    mockBucket()
    const parts = await attachmentParts([
      { name: 'cat.png', type: 'image/png', size: 3, uploadStatus: 'completed', uploadedUrl: 'u1', uploadedPath: `c/${CHANNEL}/${UID}/1.png` },
      { name: 'clip.mp4', type: 'video/mp4', uploadStatus: 'uploading' },
      { name: 'notes.txt', type: 'text/plain', uploadStatus: 'completed', uploadedUrl: 'https://legacy.example/n.txt' },
    ], `c/${CHANNEL}`)
    expect(parts).toEqual([
      { type: 'file', url: 'u1', path: `c/${CHANNEL}/${UID}/1.png`, fileType: 'image', fileName: 'cat.png', fileSize: 3 },
      { type: 'file', url: 'https://legacy.example/n.txt', fileType: 'file', fileName: 'notes.txt' },
    ])
    await expect(attachmentParts([
      { name: 'cat.png', type: 'image/png', uploadStatus: 'completed', uploadedUrl: 'u1', uploadedPath: `c/${CHANNEL}/${UID}/1.png` },
    ], null)).rejects.toThrow(/channel or conversation/)
  })
})
