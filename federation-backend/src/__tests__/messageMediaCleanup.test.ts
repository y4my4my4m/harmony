import { describe, it, expect, vi, beforeEach } from 'vitest'

// delete-message-media jobs and the hourly sweep delete only what
// public.message_media_deletable returns, through storage-api.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', SUPABASE_SERVICE_ROLE_KEY: 'k' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const rpc = vi.fn()
const remove = vi.fn()
const bucket = vi.fn()
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    rpc: (...args: unknown[]) => rpc(...args),
    storage: { from: (b: string) => { bucket(b); return { remove: (...args: unknown[]) => remove(...args) } } },
  }),
}))

const { handleMessageMediaCleanupJob, sweepMessageMedia, SWEEP_BATCH } =
  await import('../queue/handlers/messageMediaCleanupHandler.js')

const A = 'c/66666666-0000-4000-8000-000000000006/u/a.png'
const B = 'd/77777777-0000-4000-8000-000000000007/u/b.pdf'

beforeEach(() => {
  rpc.mockReset()
  remove.mockReset()
  bucket.mockReset()
  remove.mockImplementation(async (paths: string[]) => ({ data: paths.map((name) => ({ name })), error: null }))
})

describe('delete-message-media', () => {
  it('deletes the dropped objects nothing else references', async () => {
    rpc.mockResolvedValue({ data: [A], error: null })
    await handleMessageMediaCleanupJob({ paths: [A, B, '../../etc/passwd', 42] })
    expect(rpc).toHaveBeenCalledWith('message_media_deletable', { p_paths: [A, B], p_min_age: '0', p_limit: SWEEP_BATCH })
    expect(bucket).toHaveBeenCalledWith('message_media')
    expect(remove).toHaveBeenCalledWith([A])
  })

  it('deletes nothing that is still referenced', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    await handleMessageMediaCleanupJob({ paths: [A] })
    expect(remove).not.toHaveBeenCalled()
  })

  it('ignores a job without object names', async () => {
    await handleMessageMediaCleanupJob({ paths: ['user_media/x.png'] })
    await handleMessageMediaCleanupJob({})
    expect(rpc).not.toHaveBeenCalled()
  })

  it('fails the job when the check fails, so it retries', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    await expect(handleMessageMediaCleanupJob({ paths: [A] })).rejects.toThrow(/boom/)
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('sweep-message-media', () => {
  it('takes objects older than a day, batch by batch', async () => {
    const full = Array.from({ length: SWEEP_BATCH }, (_, i) => `c/66666666-0000-4000-8000-000000000006/u/${i}.png`)
    rpc.mockResolvedValueOnce({ data: full, error: null }).mockResolvedValueOnce({ data: [A], error: null })
    await expect(sweepMessageMedia()).resolves.toBe(SWEEP_BATCH + 1)
    expect(rpc).toHaveBeenNthCalledWith(1, 'message_media_deletable', { p_paths: null, p_min_age: '24 hours', p_limit: SWEEP_BATCH })
    expect(remove).toHaveBeenCalledTimes(2)
  })

  it('stops when nothing is left', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    await expect(sweepMessageMedia()).resolves.toBe(0)
    expect(remove).not.toHaveBeenCalled()
  })
})
