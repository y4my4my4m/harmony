import crypto from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Drive upkeep: server hashes recorded through drive_record_hash (a blocked hash deletes the
// object), objects of gone files deleted per bucket, and the sweep's order of calls.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', SUPABASE_SERVICE_ROLE_KEY: 'k' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const rpc = vi.fn()
const remove = vi.fn()
const sign = vi.fn()
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    rpc: (...args: unknown[]) => rpc(...args),
    storage: {
      from: (bucket: string) => ({
        remove: (paths: string[]) => remove(bucket, paths),
        createSignedUrl: (path: string) => sign(bucket, path),
      }),
    },
  }),
}))

const { handleDriveHashJob, purgeGoneObjects, sweepDrive, PURGE_BATCH } = await import('../queue/handlers/driveHandler.js')

const BYTES = new TextEncoder().encode('drive bytes')
const SHA = crypto.createHash('sha256').update(BYTES).digest('hex')
const PATH = 'u/aaaaaaaa-0000-4000-8000-000000000001/a.bin'

beforeEach(() => {
  rpc.mockReset()
  remove.mockReset()
  sign.mockReset()
  remove.mockImplementation(async (_bucket: string, paths: string[]) => ({ data: paths.map((name) => ({ name })), error: null }))
  sign.mockResolvedValue({ data: { signedUrl: 'https://storage.test/object/sign/x' }, error: null })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(BYTES)))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('drive-hash', () => {
  it('records the SHA-256 of the stored bytes', async () => {
    rpc.mockResolvedValue({ data: 'ok', error: null })
    await handleDriveHashJob({ bucket: 'message_media', path: PATH })
    expect(rpc).toHaveBeenCalledWith('drive_record_hash', { p_bucket: 'message_media', p_path: PATH, p_sha256: SHA })
    expect(remove).not.toHaveBeenCalled()
  })

  it('deletes the object when the hash is blocked', async () => {
    rpc.mockResolvedValue({ data: 'blocked', error: null })
    await handleDriveHashJob({ bucket: 'user_media', path: PATH })
    expect(remove).toHaveBeenCalledWith('user_media', [PATH])
  })

  it('ignores jobs naming other buckets or climbing paths', async () => {
    await handleDriveHashJob({ bucket: 'avatars', path: PATH })
    await handleDriveHashJob({ bucket: 'message_media', path: 'c/../x' })
    await handleDriveHashJob({})
    expect(rpc).not.toHaveBeenCalled()
  })

  it('fails the job when the download fails, so it retries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    await expect(handleDriveHashJob({ bucket: 'message_media', path: PATH })).rejects.toThrow(/HTTP 500/)
  })
})

describe('purge', () => {
  it('deletes the objects of gone files per bucket, batch by batch', async () => {
    const full = Array.from({ length: PURGE_BATCH }, (_, i) => ({ bucket: i % 2 ? 'user_media' : 'message_media', path: `p/${i}` }))
    rpc.mockResolvedValueOnce({ data: full, error: null }).mockResolvedValueOnce({ data: [], error: null })
    await expect(purgeGoneObjects()).resolves.toBe(PURGE_BATCH)
    expect(remove).toHaveBeenCalledWith('message_media', expect.arrayContaining(['p/0', 'p/2']))
    expect(remove).toHaveBeenCalledWith('user_media', expect.arrayContaining(['p/1', 'p/3']))
  })
})

describe('sweep-drive', () => {
  it('expires, purges, tracks, hashes and prunes', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'drive_hash_pending') return { data: [{ bucket: 'message_media', path: PATH }], error: null }
      if (name === 'drive_objects_to_delete') return { data: [], error: null }
      if (name === 'drive_record_hash') return { data: 'ok', error: null }
      return { data: 0, error: null }
    })
    await sweepDrive()
    expect(rpc.mock.calls.map((c) => c[0])).toEqual([
      'drive_expire_due', 'drive_objects_to_delete', 'drive_track_missing', 'drive_hash_pending',
      'drive_record_hash', 'drive_prune_gone',
    ])
  })

  it('keeps sweeping when one file cannot be hashed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    rpc.mockImplementation(async (name: string) => {
      if (name === 'drive_hash_pending') return { data: [{ bucket: 'message_media', path: PATH }], error: null }
      if (name === 'drive_objects_to_delete') return { data: [], error: null }
      return { data: 0, error: null }
    })
    await expect(sweepDrive()).resolves.toBeUndefined()
    expect(rpc).toHaveBeenLastCalledWith('drive_prune_gone', { p_limit: 500 })
  })
})
