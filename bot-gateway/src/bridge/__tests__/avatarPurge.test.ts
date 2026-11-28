import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const BOT = '00000000-0000-0000-0000-0000000000b0'
const S1 = '00000000-0000-0000-0000-000000000051'
const S2 = '00000000-0000-0000-0000-000000000052'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), bucket: vi.fn(), list: vi.fn(), remove: vi.fn() }))
vi.mock('../../config/supabase.js', () => ({
  supabase: {
    rpc: mocks.rpc,
    storage: { from: (bucket: string) => { mocks.bucket(bucket); return { list: mocks.list, remove: mocks.remove } } },
  },
  config: {},
}))

import { purgeUnboundAvatars, startAvatarPurge } from '../avatarPurge.js'

// The avatars bucket; a pair bridge_avatar_unbound lists is one with objects left.
let objects: string[]
const folder = (server: string) => `bridges/${BOT}/${server}`

beforeEach(() => {
  objects = []
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.rpc.mockImplementation(async (fn: string) => {
    expect(fn).toBe('bridge_avatar_unbound')
    const servers = [S1, S2].filter((s) => objects.some((path) => path.startsWith(`${folder(s)}/`)))
    return { data: servers.map((server_id) => ({ bot_id: BOT, server_id })), error: null }
  })
  mocks.list.mockImplementation(async (prefix: string, { limit }: { limit: number }) => ({
    data: objects.filter((path) => path.startsWith(`${prefix}/`)).slice(0, limit).map((path) => ({ name: path.slice(prefix.length + 1) })),
    error: null,
  }))
  mocks.remove.mockImplementation(async (paths: string[]) => {
    const gone = objects.filter((path) => paths.includes(path))
    objects = objects.filter((path) => !paths.includes(path))
    return { data: gone.map((name) => ({ name })), error: null }
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('purgeUnboundAvatars', () => {
  it('removes the avatars of every pair the database lists, and nothing else', async () => {
    objects = [`${folder(S1)}/a.png`, `${folder(S1)}/b.webp`, `${folder(S2)}/c.png`, 'bridges/other/x/y.png', 'alice/avatar.png']
    expect(await purgeUnboundAvatars()).toBe(3)
    expect(objects).toEqual(['bridges/other/x/y.png', 'alice/avatar.png'])
    expect(new Set(mocks.bucket.mock.calls.flat())).toEqual(new Set(['avatars']))
    expect(await purgeUnboundAvatars()).toBe(0)
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })

  it('finishes a long folder over several passes', async () => {
    objects = Array.from({ length: 2300 }, (_, i) => `${folder(S1)}/${i}.png`)
    expect(await purgeUnboundAvatars()).toBe(1000)
    expect(mocks.remove.mock.calls.map(([paths]) => paths.length)).toEqual([500, 500])
    expect(await purgeUnboundAvatars()).toBe(1000)
    expect(await purgeUnboundAvatars()).toBe(300)
    expect(objects).toEqual([])
  })

  it('goes on past a folder storage fails, which the next pass takes', async () => {
    objects = [`${folder(S1)}/a.png`, `${folder(S2)}/b.png`]
    mocks.list.mockResolvedValueOnce({ data: null, error: { message: 'storage down' } })
    expect(await purgeUnboundAvatars()).toBe(1)
    expect(objects).toEqual([`${folder(S1)}/a.png`])
    mocks.remove.mockResolvedValueOnce({ data: null, error: { message: 'storage down' } })
    expect(await purgeUnboundAvatars()).toBe(0)
    expect(await purgeUnboundAvatars()).toBe(1)
    expect(objects).toEqual([])
  })

  it('removes nothing while the list cannot be read', async () => {
    objects = [`${folder(S1)}/a.png`]
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'offline' } })
    expect(await purgeUnboundAvatars()).toBe(0)
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('runs one pass at a time, at start and every five minutes until stopped', async () => {
    vi.useFakeTimers()
    let answer: (value: unknown) => void = () => {}
    mocks.rpc.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const stop = startAvatarPurge()
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    answer({ data: [], error: null })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
    answer({ data: [], error: null })
    stop()
    await vi.advanceTimersByTimeAsync(900_000)
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })
})
