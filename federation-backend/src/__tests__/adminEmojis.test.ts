import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// /admin/emojis: an instance admin copies a remote emoji, or an instance emoji still pointing at
// another host, into the emojis bucket; import_remote_emoji / rehost_emoji record the copy.

const cfg = vi.hoisted(() => ({
  INSTANCE_DOMAIN: 'harmony.test',
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://kong:8000',
  PUBLIC_SUPABASE_URL: 'https://db.harmony.test',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
}))
vi.mock('../config/index.js', () => ({ default: cfg, config: cfg }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const allow = vi.hoisted(() => ({ value: true }))
vi.mock('../middleware/rateLimit.js', () => ({
  createStrictKeyedLimit: () => ({
    take: async (res: { status: (n: number) => { json: (b: unknown) => void } }) => {
      if (!allow.value) res.status(429).json({ error: 'Too Many Requests' })
      return allow.value
    },
    tryTake: async () => allow.value,
  }),
}))

const getUser = vi.fn()
const caller = vi.fn()
const remoteRow = vi.fn()
const emojiRow = vi.fn()
const rpc = vi.fn()
const upload = vi.fn()
const remove = vi.fn()
const getBucket = vi.fn()
const fetchImage = vi.fn()

function query(result: () => unknown) {
  const chain: Record<string, unknown> = {}
  for (const name of ['select', 'eq']) chain[name] = () => chain
  chain.maybeSingle = async () => result()
  return chain
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClientWithAuth: () => ({ auth: { getUser: () => getUser() } }),
  getSupabaseClient: () => ({
    from: (table: string) =>
      query(() => (table === 'profiles' ? caller() : table === 'remote_emojis_cache' ? remoteRow() : emojiRow())),
    rpc: (...args: unknown[]) => rpc(...args),
    storage: {
      getBucket: (...a: unknown[]) => getBucket(...a),
      from: () => ({ upload: (...a: unknown[]) => upload(...a), remove: (...a: unknown[]) => remove(...a) }),
    },
  }),
}))
vi.mock('../utils/ssrfProtection.js', () => ({ safeFetch: (...a: unknown[]) => fetchImage(...a) }))

const { default: router, sniffImage, resetBucketLimits } = await import('../routes/adminEmojis.js')
const app = express()
app.use(express.json())
app.use('/admin/emojis', router)

const FIXTURES = resolve(__dirname, '../../../tests/fixtures/media-metadata')
const PNG = readFileSync(resolve(FIXTURES, 'gps.png'))
const REMOTE_ID = '0e0e0e0e-0000-4000-8000-000000000001'
const EMOJI_ID = '0e0e0e0e-0000-4000-8000-000000000002'
const ADMIN = { id: 'p-admin', is_admin: true, is_suspended: false }
const auth = { Authorization: 'Bearer token' }
const PATH_RE = /^00000000-0000-0000-0000-000000000000\/[0-9a-f-]{36}\.png$/

const imported = (over: Record<string, unknown> = {}) => ({
  id: 'e-new', name: 'blobcat', url: 'https://db.harmony.test/storage/v1/object/public/emojis/x.png',
  imported_from: 'https://remote.example/emoji/blobcat.png', ...over,
})

beforeEach(() => {
  for (const fn of [getUser, caller, remoteRow, emojiRow, rpc, upload, remove, getBucket, fetchImage]) fn.mockReset()
  allow.value = true
  resetBucketLimits()
  getUser.mockResolvedValue({ data: { user: { id: 'auth-admin' } }, error: null })
  caller.mockReturnValue({ data: ADMIN, error: null })
  remoteRow.mockReturnValue({ data: { id: REMOTE_ID, url: 'https://remote.example/emoji/blobcat.png', imported_as: null }, error: null })
  emojiRow.mockReturnValue({
    data: { id: EMOJI_ID, url: 'https://remote.example/emoji/old.png', server_id: null, scope: 'instance', domain: null },
    error: null,
  })
  getBucket.mockResolvedValue({ data: { file_size_limit: 1048576, allowed_mime_types: ['image/png', 'image/gif', 'image/webp', 'image/apng', 'image/jpeg'] }, error: null })
  fetchImage.mockImplementation(async () => new Response(PNG, { status: 200, headers: { 'Content-Type': 'text/html' } }))
  upload.mockResolvedValue({ error: null })
  remove.mockResolvedValue({ error: null })
  rpc.mockResolvedValue({ data: imported(), error: null })
})

describe('admin emojis: who may call', () => {
  it('answers 401 without a token and fetches nothing', async () => {
    const res = await supertest(app).post('/admin/emojis/import').send({ remoteEmojiId: REMOTE_ID })
    expect(res.status).toBe(401)
    expect(fetchImage).not.toHaveBeenCalled()
  })

  it.each([
    ['a member', { id: 'p-member', is_admin: false, is_suspended: false }],
    ['a suspended admin', { id: 'p-admin', is_admin: true, is_suspended: true }],
    ['an account without a local profile', null],
  ])('answers 403 to %s on both routes', async (_name, profile) => {
    caller.mockReturnValue({ data: profile, error: null })
    const answers = await Promise.all([
      supertest(app).post('/admin/emojis/import').set(auth).send({ remoteEmojiId: REMOTE_ID }),
      supertest(app).post(`/admin/emojis/${EMOJI_ID}/rehost`).set(auth),
    ])
    expect(answers.map((r) => [r.status, r.body.error])).toEqual(Array(2).fill([403, 'admin_required']))
    expect(fetchImage).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('stops at the rate limit before any fetch', async () => {
    allow.value = false
    const res = await supertest(app).post('/admin/emojis/import').set(auth).send({ remoteEmojiId: REMOTE_ID })
    expect(res.status).toBe(429)
    expect(fetchImage).not.toHaveBeenCalled()
  })
})

describe('admin emojis: import', () => {
  it('downloads the remote image, stores it in the instance folder without metadata, and records its public URL', async () => {
    const res = await supertest(app).post('/admin/emojis/import').set(auth).send({ remoteEmojiId: REMOTE_ID, name: 'blob_cat' })
    expect(res.status).toBe(201)
    expect(res.body.emoji).toEqual(imported())
    expect(fetchImage.mock.calls[0][0]).toBe('https://remote.example/emoji/blobcat.png')
    expect(fetchImage.mock.calls[0][1]).toMatchObject({ maxBodyBytes: 1048576 })
    const [path, bytes, options] = upload.mock.calls[0]
    expect(path).toMatch(PATH_RE)
    expect(options).toEqual({ contentType: 'image/png', upsert: false })
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('HarmonyCam')
    expect(rpc).toHaveBeenCalledWith('import_remote_emoji', {
      p_remote_emoji_id: REMOTE_ID,
      p_name: 'blob_cat',
      p_path: path,
      p_url: `https://db.harmony.test/storage/v1/object/public/emojis/${path}`,
      p_actor: 'p-admin',
    })
    expect(remove).not.toHaveBeenCalled()
  })

  it.each([
    [{ remoteEmojiId: 'nope' }, 'invalid_emoji'],
    [{ remoteEmojiId: REMOTE_ID, name: 'has space' }, 'invalid_name'],
    [{ remoteEmojiId: REMOTE_ID, name: 7 }, 'invalid_name'],
  ])('refuses %j before fetching', async (body, code) => {
    const res = await supertest(app).post('/admin/emojis/import').set(auth).send(body)
    expect([res.status, res.body.error]).toEqual([400, code])
    expect(fetchImage).not.toHaveBeenCalled()
  })

  it('answers 404 and 409 for an absent or imported cache row', async () => {
    remoteRow.mockReturnValueOnce({ data: null, error: null })
    const absent = await supertest(app).post('/admin/emojis/import').set(auth).send({ remoteEmojiId: REMOTE_ID })
    remoteRow.mockReturnValueOnce({ data: { id: REMOTE_ID, url: 'https://remote.example/a.png', imported_as: 'e1' }, error: null })
    const done = await supertest(app).post('/admin/emojis/import').set(auth).send({ remoteEmojiId: REMOTE_ID })
    expect([absent.status, absent.body.error, done.status, done.body.error]).toEqual([404, 'not_found', 409, 'already_imported'])
    expect(fetchImage).not.toHaveBeenCalled()
  })

  it('refuses bytes that are no image, whatever the remote content type says', async () => {
    fetchImage.mockResolvedValue(new Response('<html>nope</html>', { status: 200, headers: { 'Content-Type': 'image/png' } }))
    const res = await supertest(app).post('/admin/emojis/import').set(auth).send({ remoteEmojiId: REMOTE_ID })
    expect([res.status, res.body.error]).toEqual([415, 'unsupported_image'])
    expect(upload).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses an image over the bucket limit', async () => {
    getBucket.mockResolvedValue({ data: { file_size_limit: 100 }, error: null })
    const res = await supertest(app).post('/admin/emojis/import').set(auth).send({ remoteEmojiId: REMOTE_ID })
    expect([res.status, res.body.error]).toEqual([413, 'too_large'])
    expect(fetchImage.mock.calls[0][1]).toMatchObject({ maxBodyBytes: 100 })
    expect(upload).not.toHaveBeenCalled()
  })

  it('maps a body cut off by safeFetch to too_large', async () => {
    fetchImage.mockRejectedValue(new Error('safeFetch: response body too large (2000000 > 1048576)'))
    const res = await supertest(app).post('/admin/emojis/import').set(auth).send({ remoteEmojiId: REMOTE_ID })
    expect([res.status, res.body.error]).toEqual([413, 'too_large'])
  })

  it.each([
    ['an error status', async () => new Response('gone', { status: 404 })],
    ['a refused address', async () => { throw new Error('Blocked private IP: 10.0.0.1') }],
  ])('answers 502 fetch_failed on %s', async (_name, answer) => {
    fetchImage.mockImplementation(answer)
    const res = await supertest(app).post('/admin/emojis/import').set(auth).send({ remoteEmojiId: REMOTE_ID })
    expect([res.status, res.body.error]).toEqual([502, 'fetch_failed'])
    expect(upload).not.toHaveBeenCalled()
  })

  it.each([
    [{ code: '23505', message: 'Emoji name already exists locally: blobcat' }, 409, 'name_taken'],
    [{ code: '23505', message: 'Emoji already imported' }, 409, 'already_imported'],
    [{ code: '22023', message: 'Emoji names are 2 to 64 letters, digits, _ or -' }, 400, 'invalid_name'],
    [{ code: 'P0002', message: 'Remote emoji not found' }, 404, 'not_found'],
    [{ code: '22023', message: 'EMOJI_URL: the url is not the public URL of x' }, 500, 'internal_error'],
  ])('removes the stored object when the record is refused (%j)', async (error, status, code) => {
    rpc.mockResolvedValue({ data: null, error })
    const res = await supertest(app).post('/admin/emojis/import').set(auth).send({ remoteEmojiId: REMOTE_ID })
    expect([res.status, res.body.error]).toEqual([status, code])
    expect(remove).toHaveBeenCalledWith([upload.mock.calls[0][0]])
  })

  it('answers 500 upload_failed when storage refuses, with nothing recorded', async () => {
    upload.mockResolvedValue({ error: { message: 'mime type not allowed' } })
    const res = await supertest(app).post('/admin/emojis/import').set(auth).send({ remoteEmojiId: REMOTE_ID })
    expect([res.status, res.body.error]).toEqual([500, 'upload_failed'])
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('admin emojis: rehost', () => {
  it('copies the hotlinked image and records it with rehost_emoji', async () => {
    rpc.mockResolvedValue({ data: imported({ id: EMOJI_ID, imported_from: 'https://remote.example/emoji/old.png' }), error: null })
    const res = await supertest(app).post(`/admin/emojis/${EMOJI_ID}/rehost`).set(auth)
    expect(res.status).toBe(200)
    expect(res.body.emoji.imported_from).toBe('https://remote.example/emoji/old.png')
    expect(fetchImage.mock.calls[0][0]).toBe('https://remote.example/emoji/old.png')
    const path = upload.mock.calls[0][0]
    expect(rpc).toHaveBeenCalledWith('rehost_emoji', {
      p_emoji_id: EMOJI_ID,
      p_path: path,
      p_url: `https://db.harmony.test/storage/v1/object/public/emojis/${path}`,
      p_actor: 'p-admin',
    })
  })

  it.each([
    ['a server emoji', { server_id: 's1', scope: 'server', domain: null }, 400, 'not_instance'],
    ['a personal emoji', { server_id: null, scope: 'user', domain: null }, 400, 'not_instance'],
    ['a federated emoji', { server_id: null, scope: 'instance', domain: 'remote.example' }, 400, 'not_instance'],
    ['one already hosted here', { url: 'https://db.harmony.test/storage/v1/object/public/emojis/00000000-0000-0000-0000-000000000000/a.png' }, 409, 'not_hotlinked'],
  ])('refuses %s without fetching', async (_name, over, status, code) => {
    emojiRow.mockReturnValue({
      data: { id: EMOJI_ID, url: 'https://remote.example/emoji/old.png', server_id: null, scope: 'instance', domain: null, ...over },
      error: null,
    })
    const res = await supertest(app).post(`/admin/emojis/${EMOJI_ID}/rehost`).set(auth)
    expect([res.status, res.body.error]).toEqual([status, code])
    expect(fetchImage).not.toHaveBeenCalled()
  })

  it('removes the copy when rehost_emoji says the emoji is already hosted', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'The emoji is already hosted here' } })
    const res = await supertest(app).post(`/admin/emojis/${EMOJI_ID}/rehost`).set(auth)
    expect([res.status, res.body.error]).toEqual([409, 'not_hotlinked'])
    expect(remove).toHaveBeenCalledTimes(1)
  })
})

describe('sniffImage', () => {
  it.each([
    ['anim.png', 'apng', 'image/png'],
    ['gps.png', 'png', 'image/png'],
    ['anim.gif', 'gif', 'image/gif'],
    ['anim.webp', 'webp', 'image/webp'],
    ['gps-upright.jpg', 'jpg', 'image/jpeg'],
  ])('reads %s as %s', (file, ext, contentType) => {
    expect(sniffImage(new Uint8Array(readFileSync(resolve(FIXTURES, file))))).toEqual({ ext, contentType })
  })

  it.each([['an svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'], ['empty', ''], ['avif', readFileSync(resolve(FIXTURES, 'gps.avif'))]])(
    'refuses %s', (_name, body) => {
      expect(sniffImage(new Uint8Array(Buffer.from(body as any)))).toBeNull()
    })
})
