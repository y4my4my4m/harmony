import { describe, expect, it, vi } from 'vitest'
import { MirrorWorker, type MirrorWorkerDeps } from '../mirrorWorker.js'
vi.mock('../../config/supabase.js', () => ({ supabase: {}, config: {} }))
import { GoneError, TooLargeError } from '../../utils/mirrorFile.js'

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
  rereads?: any[]
  mirror?: any
  message?: any
} = {}) {
  const content = opts.content ?? [{ type: 'file', url: fresh(), fileName: 'a.png', fileSize: 10 }]
  const calls: Array<[string, any]> = []
  const updates = [...(opts.updateResults ?? [true])]
  const reads = [...(opts.rereads ?? [])]
  let mode = opts.mode ?? 'mirror'
  const rpc = vi.fn(async (name: string, args: any) => {
    calls.push([name, args])
    switch (name) {
      case 'bridge_mirror_observe': return { walk_done: opts.walkDone ?? true }
      case 'bridge_mirror_backfill': return 3
      case 'bridge_mirror_claim':
        return opts.claimed === false ? [] : [{ message_id: 'm1', bot_id: 'b1', channel_id: 'c1', attempts: opts.attempts ?? 0 }]
      case 'update_message_content_silent': return updates.length > 1 ? updates.shift() : updates[0]
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
  const deps: MirrorWorkerDeps = {
    rpc, readMessage, mode: async () => mode, ceiling: async () => 50_000_000, mirror,
    gateway, now: () => NOW, log: { info() {}, warn() {}, error() {} },
  }
  const worker = new MirrorWorker(deps)
  const finish = () => calls.filter((c) => c[0] === 'bridge_mirror_finish').map((c) => c[1])
  return { worker, calls, rpc, mirror, gateway, finish, setMode: (m: any) => { mode = m }, readMessage }
}

describe('MirrorWorker.tick', () => {
  it('is idle without claiming when mode is link', async () => {
    const t = setup({ mode: 'link' })
    expect(await t.worker.tick()).toBe('idle')
    expect(t.calls.map((c) => c[0])).not.toContain('bridge_mirror_claim')
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

  it('queues for 60 s when the swap loses twice', async () => {
    const t = setup({ updateResults: [false, false] })
    await t.worker.tick()
    expect(t.finish()[0]).toMatchObject({ p_state: 'queued', p_retry_seconds: 60 })
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
