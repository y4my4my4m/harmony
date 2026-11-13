import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MirrorWorker, sweepMirrorTemp, type MirrorWorkerDeps } from '../mirrorWorker.js'

const supa = vi.hoisted(() => ({ rpc: vi.fn(), remove: vi.fn(), bucket: vi.fn() }))
vi.mock('../../config/supabase.js', () => ({
  supabase: {
    rpc: supa.rpc,
    storage: {
      from: (bucket: string) => {
        supa.bucket(bucket)
        return { remove: supa.remove }
      },
    },
  },
  config: {},
}))
import { GoneError, OverQuotaError, TooLargeError } from '../../utils/mirrorFile.js'
import { discardMirroredParts, isDatabaseRefusal, removeUnreferencedMirrors } from '../mirrorEnqueue.js'

const NOW = 1_800_000_000_000
const fresh = (name = 'a') =>
  `https://cdn.discordapp.com/attachments/1/2/${name}.png?ex=${Math.floor((NOW + 86_400_000) / 1000).toString(16)}&is=x&hm=y`
const stale = (name = 'a') =>
  `https://cdn.discordapp.com/attachments/1/2/${name}.png?ex=${Math.floor((NOW - 1000) / 1000).toString(16)}&is=x&hm=y`

function setup(opts: {
  content?: any[]
  mode?: 'link' | 'refresh' | 'mirror'
  claimed?: boolean
  attempts?: number
  connected?: boolean
  walkDone?: boolean
  updateResults?: boolean[]
  /** The code on the error update_message_content_silent throws; '' is a failure without one. */
  updateThrows?: string
  restartThrows?: number
  rereads?: any[]
  mirror?: any
  message?: any
} = {}) {
  const content = opts.content ?? [{ type: 'file', url: fresh(), fileName: 'a.png', fileSize: 10 }]
  const calls: Array<[string, any]> = []
  const updates = [...(opts.updateResults ?? [true])]
  const reads = [...(opts.rereads ?? [])]
  let mode: 'link' | 'refresh' | 'mirror' | Error = opts.mode ?? 'mirror'
  let restartThrows = opts.restartThrows ?? 0
  const rpc = vi.fn(async (name: string, args: any) => {
    calls.push([name, args])
    switch (name) {
      case 'bridge_mirror_restart_walk':
        if (restartThrows-- > 0) throw new Error('restart failed')
        return null
      case 'bridge_mirror_observe': return { walk_done: opts.walkDone ?? true }
      case 'bridge_mirror_backfill': return 3
      case 'bridge_mirror_claim':
        return opts.claimed === false ? [] : [{ message_id: 'm1', attempts: opts.attempts ?? 0 }]
      case 'update_message_content_silent':
        if (opts.updateThrows !== undefined) {
          throw Object.assign(new Error('update_message_content_silent failed: boom'), { code: opts.updateThrows })
        }
        return updates.length > 1 ? updates.shift() : updates[0]
      default: return null
    }
  })
  const readMessage = vi.fn(async () => {
    if (reads.length) return reads.shift()
    return opts.message === undefined ? { id: 'm1', content, channel_id: 'c1', bot_id: 'b1' } : opts.message
  })
  const mirror = opts.mirror ?? vi.fn(async (url: string) => ({
    path: `c/c1/bridge/b1/${url.includes('b.png') ? 'B' : 'A'}.png`, url: 'ref:A', contentType: 'image/png', bytes: 10,
  }))
  const gateway = { isBotConnected: vi.fn(() => opts.connected ?? true), sendToBot: vi.fn(() => 1) }
  const ceiling = vi.fn(async () => 50_000_000)
  const discard = vi.fn(async (_paths: string[]) => 0)
  const deps: MirrorWorkerDeps = {
    rpc, readMessage, ceiling, mirror, discard,
    mode: async () => {
      if (mode instanceof Error) throw mode
      return mode
    },
    gateway, now: () => NOW, log: { info() {}, warn() {}, error() {} },
  }
  const worker = new MirrorWorker(deps)
  const finish = () => calls.filter((c) => c[0] === 'bridge_mirror_finish').map((c) => c[1])
  const names = () => calls.map((c) => c[0])
  return { worker, calls, names, rpc, mirror, gateway, finish, ceiling, discard, setMode: (m: any) => { mode = m }, readMessage }
}

describe('MirrorWorker.tick', () => {
  it('is idle without claiming when mode is link', async () => {
    const t = setup({ mode: 'link' })
    expect(await t.worker.tick()).toBe('idle')
    expect(t.calls.map((c) => c[0])).not.toContain('bridge_mirror_claim')
  })

  it('reads the mode and nothing else while the mode is not mirror', async () => {
    for (const mode of ['link', 'refresh'] as const) {
      const t = setup({ mode })
      expect(await t.worker.tick()).toBe('idle')
      expect(await t.worker.tick()).toBe('idle')
      expect(t.rpc).not.toHaveBeenCalled()
      expect(t.ceiling).not.toHaveBeenCalled()
      expect(t.readMessage).not.toHaveBeenCalled()
    }
  })

  it('restarts the walk on entering mirror mode, the first tick included, and not while it stays there', async () => {
    const t = setup({ claimed: false })
    await t.worker.tick()
    expect(t.names().slice(0, 2)).toEqual(['bridge_mirror_restart_walk', 'bridge_mirror_observe'])
    await t.worker.tick()
    expect(t.names().filter((n) => n === 'bridge_mirror_restart_walk')).toHaveLength(1)

    t.setMode('link')
    await t.worker.tick()
    const before = t.calls.length
    t.setMode('mirror')
    await t.worker.tick()
    expect(t.names().slice(before, before + 2)).toEqual(['bridge_mirror_restart_walk', 'bridge_mirror_observe'])
    expect(t.calls[before + 1][1]).toEqual({ p_mode: 'mirror', p_ceiling: 50_000_000 })
  })

  it('does not take a failed mode read for a change of mode', async () => {
    const t = setup({ claimed: false })
    await t.worker.tick()
    t.setMode(new Error('bridge_attachment_mode read failed: timeout'))
    await expect(t.worker.tick()).rejects.toThrow(/read failed/)
    t.setMode('mirror')
    await t.worker.tick()
    expect(t.names().filter((n) => n === 'bridge_mirror_restart_walk')).toHaveLength(1)
  })

  it('restarts the walk on the next tick when the restart failed', async () => {
    const t = setup({ claimed: false, restartThrows: 1 })
    await expect(t.worker.tick()).rejects.toThrow(/restart failed/)
    expect(t.names()).toEqual(['bridge_mirror_restart_walk'])
    await t.worker.tick()
    expect(t.names().slice(0, 3)).toEqual(['bridge_mirror_restart_walk', 'bridge_mirror_restart_walk', 'bridge_mirror_observe'])
  })

  it('is idle when nothing is claimed', async () => {
    const t = setup({ claimed: false })
    expect(await t.worker.tick()).toBe('idle')
  })

  it('mirrors a fresh link and writes the part', async () => {
    const t = setup()
    expect(await t.worker.tick()).toBe('worked')
    const upd = t.calls.find((c) => c[0] === 'update_message_content_silent')![1]
    expect(upd.p_message_id).toBe('m1')
    expect(upd.p_content[0]).toMatchObject({ type: 'file', fileType: 'image', url: 'ref:A', path: 'c/c1/bridge/b1/A.png' })
    expect(t.mirror.mock.calls[0][1]).toMatchObject({ botId: 'b1', channelId: 'c1', knownSize: 10, ceiling: 50_000_000 })
    expect(t.finish()[0]).toMatchObject({ p_message_id: 'm1', p_state: 'done', p_attempts: 0 })
  })

  it('skips parts that already have a path', async () => {
    const t = setup({ content: [{ type: 'file', url: fresh(), path: 'x/y.png' }] })
    await t.worker.tick()
    expect(t.mirror).not.toHaveBeenCalled()
    expect(t.finish()[0].p_state).toBe('done')
  })

  it('asks the bridge to refresh an expired link', async () => {
    const content = [{ type: 'file', url: stale() }]
    const t = setup({ content, attempts: 1 })
    await t.worker.tick()
    expect(t.gateway.sendToBot).toHaveBeenCalledWith('b1', {
      op: 0, t: 'REFRESH_ATTACHMENTS', d: { messageId: 'm1', channelId: 'c1', content },
    })
    expect(t.mirror).not.toHaveBeenCalled()
    expect(t.finish()[0]).toMatchObject({ p_state: 'queued', p_retry_seconds: 120, p_attempts: 2 })
  })

  it('asks the bridge to re-sign an unsigned attachment link instead of downloading it', async () => {
    const content = [{ type: 'file', url: 'https://cdn.discordapp.com/attachments/1/2/a.png' }]
    const t = setup({ content })
    await t.worker.tick()
    expect(t.gateway.sendToBot).toHaveBeenCalledWith('b1', {
      op: 0, t: 'REFRESH_ATTACHMENTS', d: { messageId: 'm1', channelId: 'c1', content },
    })
    expect(t.mirror).not.toHaveBeenCalled()
    expect(t.finish()[0]).toMatchObject({ p_state: 'queued', p_retry_seconds: 120, p_attempts: 1 })
  })

  it('downloads an unsigned proxied link as is', async () => {
    const t = setup({ content: [{ type: 'url', url: 'https://images-ext-1.discordapp.net/external/x/https/example.com/a.png' }] })
    await t.worker.tick()
    expect(t.gateway.sendToBot).not.toHaveBeenCalled()
    expect(t.mirror).toHaveBeenCalledTimes(1)
  })

  it('fails on the fifth refresh', async () => {
    const t = setup({ content: [{ type: 'file', url: stale() }], attempts: 4 })
    await t.worker.tick()
    expect(t.finish()[0]).toMatchObject({ p_state: 'failed', p_attempts: 5 })
    expect(t.finish()[0].p_error).toContain('Discord would not refresh the link')
  })

  it('retries in 900 s without counting when the bot is offline', async () => {
    const t = setup({ content: [{ type: 'file', url: stale() }], attempts: 2, connected: false })
    await t.worker.tick()
    expect(t.gateway.sendToBot).not.toHaveBeenCalled()
    expect(t.finish()[0]).toMatchObject({ p_state: 'queued', p_retry_seconds: 900, p_attempts: 2 })
  })

  it('writes the other part and finishes too_large', async () => {
    const mirror = vi.fn(async (url: string) => {
      if (url.includes('/a.png')) throw new TooLargeError(600_000_000)
      return { path: 'p/B.png', url: 'ref:B', contentType: 'image/png', bytes: 5 }
    })
    const t = setup({ content: [{ type: 'file', url: fresh('a') }, { type: 'file', url: fresh('b') }], mirror })
    await t.worker.tick()
    const upd = t.calls.find((c) => c[0] === 'update_message_content_silent')![1]
    expect(upd.p_content[0].path).toBeUndefined()
    expect(upd.p_content[1].path).toBe('p/B.png')
    expect(t.finish()[0]).toMatchObject({ p_state: 'too_large', p_largest_bytes: 600000000 })
  })

  it('writes the other part and finishes over_quota when the cap refuses a file', async () => {
    const mirror = vi.fn(async (url: string) => {
      if (url.includes('/a.png')) throw new OverQuotaError(7_000_000)
      return { path: 'c/c1/bridge/b1/B.png', url: 'ref:B', contentType: 'image/png', bytes: 5 }
    })
    const t = setup({ content: [{ type: 'file', url: fresh('a') }, { type: 'file', url: fresh('b') }], mirror })
    await t.worker.tick()
    const upd = t.calls.find((c) => c[0] === 'update_message_content_silent')![1]
    expect(upd.p_content[0].path).toBeUndefined()
    expect(upd.p_content[1].path).toBe('c/c1/bridge/b1/B.png')
    expect(t.finish()[0]).toMatchObject({ p_state: 'over_quota', p_attempts: 0, p_error: 'over the server limit' })
    expect(t.discard).not.toHaveBeenCalled()
  })

  it('finishes over_quota ahead of too_large, and retries a failed part ahead of both', async () => {
    const refuse = (errors: Record<string, Error>) => vi.fn(async (url: string) => {
      const name = url.includes('/a.png') ? 'a' : url.includes('/b.png') ? 'b' : 'c'
      throw errors[name]
    })
    const content = [{ type: 'file', url: fresh('a') }, { type: 'file', url: fresh('b') }, { type: 'file', url: fresh('c') }]
    const both = setup({ content, mirror: refuse({ a: new TooLargeError(9), b: new OverQuotaError(9), c: new TooLargeError(9) }) })
    await both.worker.tick()
    expect(both.finish()[0]).toMatchObject({ p_state: 'over_quota' })
    const failing = setup({ content, mirror: refuse({ a: new OverQuotaError(9), b: new Error('boom'), c: new TooLargeError(9) }) })
    await failing.worker.tick()
    expect(failing.finish()[0]).toMatchObject({ p_state: 'queued', p_attempts: 1, p_retry_seconds: 60 })
  })

  it('fails a gone file that has a valid link', async () => {
    const mirror = vi.fn(async () => { throw new GoneError(404) })
    const t = setup({ mirror })
    await t.worker.tick()
    expect(t.finish()[0]).toMatchObject({ p_state: 'failed' })
    expect(t.finish()[0].p_error).toContain('gone from Discord')
  })

  it('re-applies the path onto edited content after a lost compare-and-swap', async () => {
    const original = [{ type: 'text', text: 'old' }, { type: 'file', url: fresh() }]
    const edited = [{ type: 'text', text: 'new' }, { type: 'file', url: fresh() }]
    const t = setup({ content: original, updateResults: [false, true], rereads: [
      { id: 'm1', content: original, channel_id: 'c1', bot_id: 'b1' },
      { id: 'm1', content: edited, channel_id: 'c1', bot_id: 'b1' },
    ] })
    await t.worker.tick()
    const updates = t.calls.filter((c) => c[0] === 'update_message_content_silent')
    expect(updates).toHaveLength(2)
    expect(updates[1][1].p_old_content).toEqual(edited)
    expect(updates[1][1].p_content[0].text).toBe('new')
    expect(updates[1][1].p_content[1].path).toBe('c/c1/bridge/b1/A.png')
    expect(t.mirror).toHaveBeenCalledTimes(1)
    expect(t.finish()[0].p_state).toBe('done')
  })

  it('queues for 60 s when the swap loses twice, and removes the stored file', async () => {
    const t = setup({ updateResults: [false, false] })
    await t.worker.tick()
    expect(t.finish()[0]).toMatchObject({ p_state: 'queued', p_retry_seconds: 60, p_attempts: 1 })
    expect(t.discard.mock.calls).toEqual([[['c/c1/bridge/b1/A.png']]])
  })

  it('leaves the stored file alone when the swap wins', async () => {
    const t = setup()
    await t.worker.tick()
    expect(t.finish()[0].p_state).toBe('done')
    expect(t.discard).not.toHaveBeenCalled()
  })

  it('removes the stored file when the message is deleted or gone by the time the swap loses', async () => {
    const live = { id: 'm1', content: [{ type: 'file', url: fresh() }], channel_id: 'c1', bot_id: 'b1' }
    for (const later of [{ ...live, is_deleted: true }, null]) {
      const t = setup({ updateResults: [false], rereads: [live, later] })
      await t.worker.tick()
      expect(t.calls.filter((c) => c[0] === 'update_message_content_silent')).toHaveLength(1)
      expect(t.discard.mock.calls).toEqual([[['c/c1/bridge/b1/A.png']]])
      expect(t.finish()[0].p_state).toBe('done')
    }
  })

  it('removes the stored file of a part an edit dropped, and keeps the one re-applied', async () => {
    const original = [{ type: 'file', url: fresh('a') }, { type: 'file', url: fresh('b') }]
    const edited = [{ type: 'text', text: 'one left' }, { type: 'file', url: fresh('b') }]
    const t = setup({ content: original, updateResults: [false, true], rereads: [
      { id: 'm1', content: original, channel_id: 'c1', bot_id: 'b1' },
      { id: 'm1', content: edited, channel_id: 'c1', bot_id: 'b1' },
    ] })
    await t.worker.tick()
    const updates = t.calls.filter((c) => c[0] === 'update_message_content_silent')
    expect(updates[1][1].p_content[1].path).toBe('c/c1/bridge/b1/B.png')
    expect(t.discard.mock.calls).toEqual([[['c/c1/bridge/b1/A.png']]])
    expect(t.finish()[0].p_state).toBe('done')
  })

  it('removes the stored file when no part holds its link after an edit', async () => {
    const original = [{ type: 'file', url: fresh('a') }]
    const t = setup({ content: original, updateResults: [false], rereads: [
      { id: 'm1', content: original, channel_id: 'c1', bot_id: 'b1' },
      { id: 'm1', content: [{ type: 'text', text: 'no file' }], channel_id: 'c1', bot_id: 'b1' },
    ] })
    await t.worker.tick()
    expect(t.calls.filter((c) => c[0] === 'update_message_content_silent')).toHaveLength(1)
    expect(t.discard.mock.calls).toEqual([[['c/c1/bridge/b1/A.png']]])
  })

  it('removes the stored file when the message was deleted while it downloaded', async () => {
    const live = { id: 'm1', content: [{ type: 'file', url: fresh() }], channel_id: 'c1', bot_id: 'b1' }
    const t = setup({ rereads: [live, { ...live, is_deleted: true }] })
    await t.worker.tick()
    expect(t.calls.filter((c) => c[0] === 'update_message_content_silent')).toHaveLength(1)
    expect(t.discard.mock.calls).toEqual([[['c/c1/bridge/b1/A.png']]])
  })

  it('removes the stored files when the database refuses the write, and retries', async () => {
    const t = setup({ updateThrows: '42501', content: [{ type: 'file', url: fresh('a') }, { type: 'file', url: fresh('b') }] })
    await t.worker.tick()
    expect(t.discard.mock.calls).toEqual([[['c/c1/bridge/b1/A.png', 'c/c1/bridge/b1/B.png']]])
    expect(t.finish()[0]).toMatchObject({ p_state: 'queued', p_attempts: 1, p_retry_seconds: 60 })
    expect(t.finish()[0].p_error).toContain('boom')
  })

  it('keeps the stored files when the write fails without a database error: it may still commit', async () => {
    for (const code of ['', 'ECONNRESET', 'EPIPE']) {
      const t = setup({ updateThrows: code })
      await t.worker.tick()
      expect(t.discard).not.toHaveBeenCalled()
      expect(t.finish()[0]).toMatchObject({ p_state: 'queued', p_attempts: 1, p_retry_seconds: 60 })
    }
  })

  it('fails with "message kept changing" when the swap loses on the last attempt', async () => {
    const t = setup({ updateResults: [false, false], attempts: 4 })
    await t.worker.tick()
    expect(t.finish()[0]).toMatchObject({ p_state: 'failed', p_attempts: 5 })
    expect(t.finish()[0].p_error).toContain('message kept changing')
    expect(t.discard).toHaveBeenCalledTimes(1)
  })

  it('leaves a deleted message untouched and finishes done', async () => {
    const t = setup({ message: { id: 'm1', content: [{ type: 'file', url: fresh() }], channel_id: 'c1', bot_id: 'b1', is_deleted: true } })
    expect(await t.worker.tick()).toBe('worked')
    expect(t.mirror).not.toHaveBeenCalled()
    expect(t.calls.map((c) => c[0])).not.toContain('update_message_content_silent')
    expect(t.finish()[0]).toMatchObject({ p_state: 'done' })
  })

  it('does not throttle the walk: worked while walk_done is false, idle once it is true', async () => {
    const walking = setup({ walkDone: false, claimed: false })
    expect(await walking.worker.tick()).toBe('worked')
    const done = setup({ walkDone: true, claimed: false })
    expect(await done.worker.tick()).toBe('idle')
  })

  it('returns worked without writing when the message is gone', async () => {
    const t = setup({ message: null })
    expect(await t.worker.tick()).toBe('worked')
    expect(t.calls.map((c) => c[0])).not.toContain('update_message_content_silent')
    expect(t.mirror).not.toHaveBeenCalled()
  })

  it('goes idle and leaves the row when the mode flips to link', async () => {
    const t = setup()
    await t.worker.tick()
    t.setMode('link')
    const before = t.finish().length
    expect(await t.worker.tick()).toBe('idle')
    expect(t.finish().length).toBe(before)
  })

  it('backs off 60, 300, 1800, 7200, then fails', async () => {
    const mirror = vi.fn(async () => { throw new Error('boom') })
    const seen: any[] = []
    for (let attempts = 0; attempts < 5; attempts++) {
      const t = setup({ mirror, attempts })
      await t.worker.tick()
      seen.push(t.finish()[0])
    }
    expect(seen.slice(0, 4).map((f) => f.p_retry_seconds)).toEqual([60, 300, 1800, 7200])
    expect(seen.slice(0, 4).every((f) => f.p_state === 'queued')).toBe(true)
    expect(seen[4]).toMatchObject({ p_state: 'failed', p_attempts: 5 })
    expect(seen[4].p_error).toContain('boom')
  })

  it('backfills while the walk is not done, and not after', async () => {
    const a = setup({ walkDone: false })
    await a.worker.tick()
    expect(a.calls.find((c) => c[0] === 'bridge_mirror_backfill')![1]).toEqual({ p_limit: 500 })
    const b = setup({ walkDone: true })
    await b.worker.tick()
    expect(b.calls.map((c) => c[0])).not.toContain('bridge_mirror_backfill')
  })
})

describe('sweepMirrorTemp', () => {
  it('removes only old mirror-* directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sweep-test-'))
    try {
      await mkdir(join(dir, 'mirror-old'))
      await mkdir(join(dir, 'mirror-new'))
      await mkdir(join(dir, 'other-old'))
      const old = new Date(NOW - 3_600_000)
      await utimes(join(dir, 'mirror-old'), old, old)
      await utimes(join(dir, 'other-old'), old, old)
      await utimes(join(dir, 'mirror-new'), new Date(NOW - 1000), new Date(NOW - 1000))
      const info = vi.fn()
      expect(await sweepMirrorTemp(dir, 1_800_000, NOW, { info, warn() {} })).toBe(1)
      expect((await readdir(dir)).sort()).toEqual(['mirror-new', 'other-old'])
      expect(info).toHaveBeenCalled()
      expect(await sweepMirrorTemp(join(dir, 'missing'), 1, NOW, { info, warn() {} })).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('removeUnreferencedMirrors', () => {
  const CHANNEL = '00000000-0000-4000-8000-0000000000c1'
  const A = `c/${CHANNEL}/bridge/b1/aaaaaaaa.png`
  const B = `c/${CHANNEL}/bridge/b1/bbbbbbbb.mp4`

  beforeEach(() => {
    supa.rpc.mockReset()
    supa.remove.mockReset()
    supa.bucket.mockReset()
    supa.remove.mockImplementation(async (paths: string[]) => ({ data: paths.map((name) => ({ name })), error: null }))
  })

  it('removes the files message_media_deletable names and leaves the referenced one', async () => {
    supa.rpc.mockResolvedValue({ data: [A], error: null })
    expect(await removeUnreferencedMirrors([A, B, A])).toBe(1)
    expect(supa.rpc.mock.calls).toEqual([['message_media_deletable', { p_paths: [A, B], p_min_age: '0', p_limit: 2 }]])
    expect(supa.bucket).toHaveBeenCalledWith('message_media')
    expect(supa.remove.mock.calls).toEqual([[[A]]])
  })

  it('reads one-column rows as names', async () => {
    supa.rpc.mockResolvedValue({ data: [{ message_media_deletable: B }], error: null })
    expect(await removeUnreferencedMirrors([A, B])).toBe(1)
    expect(supa.remove.mock.calls).toEqual([[[B]]])
  })

  it('removes nothing when every file is referenced', async () => {
    supa.rpc.mockResolvedValue({ data: [], error: null })
    expect(await removeUnreferencedMirrors([A, B])).toBe(0)
    expect(supa.remove).not.toHaveBeenCalled()
  })

  it('asks about the mirror paths only, and removes no name it did not ask about', async () => {
    const member = `c/${CHANNEL}/11111111-0000-4000-8000-000000000001/photo.png`
    supa.rpc.mockResolvedValue({ data: [A, member], error: null })
    await removeUnreferencedMirrors([
      member,
      `d/${CHANNEL}/bridge/b1/x.png`,
      `c/${CHANNEL}/bridge/b1`,
      `c/${CHANNEL}/bridge/b1/deeper/x.png`,
      `c/${CHANNEL}/bridged/b1/x.png`,
      'c/not-a-channel/bridge/b1/x.png',
      undefined as any,
      A,
    ])
    expect(supa.rpc.mock.calls[0][1].p_paths).toEqual([A])
    expect(supa.remove.mock.calls).toEqual([[[A]]])

    supa.rpc.mockClear()
    expect(await removeUnreferencedMirrors([member])).toBe(0)
    expect(supa.rpc).not.toHaveBeenCalled()
  })

  it('asks in batches of 500', async () => {
    const names = Array.from({ length: 501 }, (_, i) => `c/${CHANNEL}/bridge/b1/${i}.png`)
    supa.rpc.mockImplementation(async (_name: string, args: any) => ({ data: args.p_paths, error: null }))
    expect(await removeUnreferencedMirrors(names)).toBe(501)
    expect(supa.rpc.mock.calls.map((call) => [call[1].p_paths.length, call[1].p_limit])).toEqual([[500, 500], [1, 1]])
    expect(supa.remove.mock.calls.map((call) => call[0].length)).toEqual([500, 1])
  })

  it('returns 0 and does not throw when the lookup or the removal fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      supa.rpc.mockResolvedValue({ data: null, error: { message: 'timeout' } })
      expect(await removeUnreferencedMirrors([A])).toBe(0)
      expect(supa.remove).not.toHaveBeenCalled()

      supa.rpc.mockRejectedValue(new Error('fetch failed'))
      expect(await removeUnreferencedMirrors([A])).toBe(0)

      supa.rpc.mockResolvedValue({ data: [A], error: null })
      supa.remove.mockResolvedValue({ data: null, error: { message: 'storage down' } })
      expect(await removeUnreferencedMirrors([A])).toBe(0)
      expect(error).toHaveBeenCalledTimes(3)
    } finally {
      error.mockRestore()
    }
  })

  it('discardMirroredParts hands over the paths of file parts', async () => {
    supa.rpc.mockResolvedValue({ data: [A], error: null })
    await discardMirroredParts([
      { type: 'text', text: 'hi' },
      { type: 'file', fileType: 'image', url: 'https://signed.test/a', path: A },
      { type: 'file', url: 'https://cdn.discordapp.com/attachments/1/2/kept.png' },
      { type: 'url', url: 'https://example.com', path: B },
      null,
    ])
    expect(supa.rpc.mock.calls[0][1].p_paths).toEqual([A])
    expect(supa.remove.mock.calls).toEqual([[[A]]])
  })

  it('discardMirroredParts removes after a database refusal and after no error, and not after any other failure', async () => {
    const parts = [{ type: 'file', url: 'https://signed.test/a', path: A }]
    supa.rpc.mockResolvedValue({ data: [A], error: null })
    for (const error of [{ code: '', message: 'TypeError: fetch failed' }, { code: 'ECONNRESET' }, { message: '<html>504 Gateway Time-out</html>' }, new Error('socket hang up')]) {
      await discardMirroredParts(parts, error)
    }
    expect(supa.rpc).not.toHaveBeenCalled()

    for (const error of [{ code: '23505', message: 'duplicate key' }, { code: 'P0001' }, { code: 'PGRST116' }, null, undefined]) {
      supa.remove.mockClear()
      await discardMirroredParts(parts, error)
      expect(supa.remove.mock.calls).toEqual([[[A]]])
    }
  })

  it('isDatabaseRefusal knows SQLSTATE and PostgREST codes from Node errno codes', () => {
    for (const code of ['23505', '42501', '22023', '0A000', '57014', '40001', 'P0001', 'P0002', 'XX000', 'PGRST116', 'PGRST202']) {
      expect(isDatabaseRefusal({ code }), code).toBe(true)
    }
    for (const code of ['', 'EPIPE', 'EINTR', 'E2BIG', 'ECONNRESET', 'UND_ERR_SOCKET', 'ETIMEDOUT', '504', undefined, null, 23505]) {
      expect(isDatabaseRefusal({ code }), String(code)).toBe(false)
    }
    expect(isDatabaseRefusal(null)).toBe(false)
    expect(isDatabaseRefusal(new Error('fetch failed'))).toBe(false)
  })

  it('discardMirroredParts asks nothing for content without mirrored parts', async () => {
    await discardMirroredParts([{ type: 'text', text: 'hi' }, { type: 'file', url: 'https://cdn.discordapp.com/attachments/1/2/a.png' }])
    await discardMirroredParts(undefined)
    await discardMirroredParts('text')
    expect(supa.rpc).not.toHaveBeenCalled()
  })
})
