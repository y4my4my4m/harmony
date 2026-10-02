import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// Federated chat attachments: capability URLs, content rewriting and the media route.

vi.mock('../config/index.js', () => {
  const cfg = {
    INSTANCE_DOMAIN: 'harmony.test',
    SUPABASE_URL: 'http://kong:8000',
    PUBLIC_SUPABASE_URL: 'https://db.harmony.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
    MEDIA_URL_SECRET: undefined as string | undefined,
    MEDIA_PUBLIC_BASE_URL: undefined as string | undefined,
  }
  return { default: cfg, config: cfg }
})
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const blocked = new Set<string>()
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: (domain: string) => blocked.has(domain) },
}))

const rpc = vi.fn()
const createSignedUrl = vi.fn()
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    rpc: (...args: unknown[]) => rpc(...args),
    storage: { from: () => ({ createSignedUrl: (...args: unknown[]) => createSignedUrl(...args) }) },
  }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const {
  federatedMediaUrl,
  federateContentParts,
  fileAttachmentsToAp,
  isPrivateMediaPath,
  mediaUrlSignature,
  stripIncomingMediaPaths,
  verifyMediaUrlSignature,
} = await import('../utils/privateMedia.js')
const { default: mediaRouter } = await import('../routes/media.js')

const CHANNEL = '66666666-0000-4000-8000-000000000006'
const CONVERSATION = '77777777-0000-4000-8000-000000000007'
const PATH = `c/${CHANNEL}/aaaaaaaa-0000-4000-8000-000000000001/cat.png`
const DM_PATH = `d/${CONVERSATION}/aaaaaaaa-0000-4000-8000-000000000001/notes.pdf`

function app() {
  const a = express()
  a.use('/media', mediaRouter)
  return a
}

function routePath(url: string): string {
  const u = new URL(url)
  return u.pathname.replace(/^\/api\/federation/, '') + u.search
}

beforeEach(() => {
  blocked.clear()
  rpc.mockReset()
  createSignedUrl.mockReset()
})

describe('capability URLs', () => {
  it('accepts room-prefixed object names only', () => {
    expect(isPrivateMediaPath(PATH)).toBe(true)
    expect(isPrivateMediaPath(DM_PATH)).toBe(true)
    expect(isPrivateMediaPath('aaaaaaaa-0000-4000-8000-000000000001/cat.png')).toBe(false)
    expect(isPrivateMediaPath(`c/${CHANNEL}/../x/cat.png`)).toBe(false)
    expect(isPrivateMediaPath(`c/${CHANNEL}//cat.png`)).toBe(false)
    expect(isPrivateMediaPath(`c/${CHANNEL}/a/cat.png?x=1`)).toBe(false)
    expect(isPrivateMediaPath(42)).toBe(false)
  })

  it('binds a URL to its path and audience', () => {
    const url = federatedMediaUrl(PATH, 'remote.example')
    expect(url).toBe(`https://harmony.test/api/federation/media/${PATH}?to=remote.example&sig=${mediaUrlSignature(PATH, 'remote.example')}`)
    const sig = new URL(url).searchParams.get('sig')
    expect(verifyMediaUrlSignature(PATH, 'remote.example', sig)).toBe(true)
    expect(verifyMediaUrlSignature(PATH, 'other.example', sig)).toBe(false)
    expect(verifyMediaUrlSignature(DM_PATH, 'remote.example', sig)).toBe(false)
    expect(verifyMediaUrlSignature(PATH, 'remote.example', undefined)).toBe(false)
  })

  it('rewrites file parts for an audience and drops their path', () => {
    const content = [
      { type: 'text', text: 'look' },
      { type: 'file', fileType: 'image', fileName: 'cat.png', url: 'https://db.harmony.test/storage/v1/object/sign/x?token=t', path: PATH },
      { type: 'file', fileType: 'file', url: 'https://cdn.example/legacy.pdf' },
      { type: 'file', fileType: 'file', url: 'u', path: 'not/a/room' },
    ]
    expect(federateContentParts(content, 'remote.example')).toEqual([
      { type: 'text', text: 'look' },
      { type: 'file', fileType: 'image', fileName: 'cat.png', url: federatedMediaUrl(PATH, 'remote.example') },
      { type: 'file', fileType: 'file', url: 'https://cdn.example/legacy.pdf' },
      { type: 'file', fileType: 'file', url: 'u' },
    ])
    expect(content[1]).toHaveProperty('path', PATH)
  })

  it('strips paths from received content', () => {
    expect(stripIncomingMediaPaths([
      { type: 'file', url: 'https://remote.example/media/x', path: DM_PATH },
      { type: 'text', text: 'hi', path: 'kept on non-file parts' },
    ])).toEqual([
      { type: 'file', url: 'https://remote.example/media/x' },
      { type: 'text', text: 'hi', path: 'kept on non-file parts' },
    ])
  })

  it('builds ActivityPub attachments for private and legacy parts', () => {
    expect(fileAttachmentsToAp([
      { type: 'file', fileType: 'image', fileName: 'cat.png', url: 'x', path: PATH },
      { type: 'file', fileType: 'audio', url: 'https://cdn.example/voice.webm' },
      { type: 'file', fileType: 'file', url: 'javascript:alert(1)' },
    ], 'remote.example')).toEqual([
      { type: 'Document', mediaType: 'image/png', url: federatedMediaUrl(PATH, 'remote.example'), name: 'cat.png' },
      { type: 'Document', mediaType: 'audio/webm', url: 'https://cdn.example/voice.webm', name: null },
    ])
  })
})

describe('GET /media/*', () => {
  it('redirects a member instance to a short-lived storage URL', async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    createSignedUrl.mockResolvedValue({ data: { signedUrl: `http://kong:8000/storage/v1/object/sign/message_media/${PATH}?token=t` }, error: null })

    const res = await supertest(app()).get(routePath(federatedMediaUrl(PATH, 'remote.example')))
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(`https://db.harmony.test/storage/v1/object/sign/message_media/${PATH}?token=t`)
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin')
    expect(rpc).toHaveBeenCalledWith('federation_media_access', { p_name: PATH, p_domain: 'remote.example' })
    expect(createSignedUrl).toHaveBeenCalledWith(PATH, 300)
  })

  it('refuses an instance that no longer receives the room', async () => {
    rpc.mockResolvedValue({ data: false, error: null })
    const res = await supertest(app()).get(routePath(federatedMediaUrl(DM_PATH, 'remote.example')))
    expect(res.status).toBe(403)
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it('refuses a URL whose audience or path was changed', async () => {
    const url = new URL(federatedMediaUrl(PATH, 'remote.example'))
    url.searchParams.set('to', 'attacker.example')
    expect((await supertest(app()).get(routePath(url.toString()))).status).toBe(403)

    const moved = federatedMediaUrl(PATH, 'remote.example').replace(CHANNEL, CONVERSATION)
    expect((await supertest(app()).get(routePath(moved))).status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('is 404 for a malformed request', async () => {
    expect((await supertest(app()).get(`/media/${PATH}`)).status).toBe(404)
    expect((await supertest(app()).get('/media/aaaa/cat.png?to=remote.example&sig=x')).status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses a blocked instance before asking the database', async () => {
    blocked.add('remote.example')
    const res = await supertest(app()).get(routePath(federatedMediaUrl(PATH, 'remote.example')))
    expect(res.status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('answers 503 when the access check fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const res = await supertest(app()).get(routePath(federatedMediaUrl(PATH, 'remote.example')))
    expect(res.status).toBe(503)
  })
})
