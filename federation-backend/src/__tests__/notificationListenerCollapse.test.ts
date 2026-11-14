import { describe, it, expect, vi, afterEach } from 'vitest'

// federate-server-update reads its server as it is when it runs: the notifications of one
// five-second window of the clock for one server make one delayed job, due at the window's end.
// BullMQ ignores a job whose id it holds, so the job id carries server and window.

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../services/FederationSwitches.js', () => ({ invalidateFederationSwitches: vi.fn() }))

const { NotificationListener, collapsedJob } = await import('../queue/NotificationListener.js')

// A queue keeping the first job of each id, as BullMQ does.
function listener() {
  const added: Array<{ name: string; data: any; opts: any }> = []
  const ids = new Set<string>()
  const queue = {
    add: vi.fn(async (name: string, data: any, opts: any) => {
      if (opts?.jobId && ids.has(opts.jobId)) return
      if (opts?.jobId) ids.add(opts.jobId)
      added.push({ name, data, opts })
    }),
  }
  const l: any = new NotificationListener('postgres://unused', () => queue as any)
  return { l, added, queue }
}

const note = (name: string, data: Record<string, unknown>) =>
  JSON.stringify({ name, id: crypto.randomUUID(), data })
const update = (serverId: string) => note('federate-server-update', { type: 'update', server_id: serverId })

afterEach(() => {
  vi.useRealTimers()
})

describe('collapsedJob', () => {
  it('names server and window, and is due at the window\'s end', () => {
    const n = { name: 'federate-server-update', data: { server_id: 's1' } }
    expect(collapsedJob(n, 10_000)).toEqual({ jobId: 'federate-server-update-s1-2', delay: 5_000 })
    expect(collapsedJob(n, 14_999)).toEqual({ jobId: 'federate-server-update-s1-2', delay: 1 })
    expect(collapsedJob(n, 15_000)).toEqual({ jobId: 'federate-server-update-s1-3', delay: 5_000 })
    expect(collapsedJob({ name: 'federate-channel-pin', data: { server_id: 's1' } }, 10_000)).toBeNull()
    expect(collapsedJob({ name: 'federate-server-update', data: {} }, 10_000)).toBeNull()
  })
})

describe('NotificationListener collapsing', () => {
  it('queues one delayed federate-server-update per server and window, and other jobs at once', async () => {
    vi.useFakeTimers({ now: 100_000 })
    const { l, added } = listener()
    for (let i = 0; i < 5; i++) {
      l.handleNotification(update('s1'))
      await vi.advanceTimersByTimeAsync(400)
    }
    l.handleNotification(update('s2'))
    l.handleNotification(note('federate-channel-pin', { type: 'update', server_id: 's1', message_id: 'm1' }))
    l.handleNotification(note('federate-channel-pin', { type: 'update', server_id: 's1', message_id: 'm2' }))
    await vi.advanceTimersByTimeAsync(100)

    const pins = added.filter(a => a.name === 'federate-channel-pin')
    expect(pins).toHaveLength(2)
    expect(pins.every(a => a.opts.jobId === undefined && a.opts.delay === undefined)).toBe(true)
    const updates = added.filter(a => a.name === 'federate-server-update')
    // Notifications reach the queue after the listener's 50 ms batch.
    expect(updates.map(a => [a.data.server_id, a.opts.jobId, a.opts.delay])).toEqual([
      ['s1', 'federate-server-update-s1-20', 4_950],
      ['s2', 'federate-server-update-s2-20', 2_950],
    ])
    expect(updates[0].opts.attempts).toBe(5)
  })

  it('a change after the window ends makes the next window\'s job', async () => {
    vi.useFakeTimers({ now: 100_000 })
    const { l, added } = listener()
    l.handleNotification(update('s1'))
    await vi.advanceTimersByTimeAsync(5_100)
    l.handleNotification(update('s1'))
    await vi.advanceTimersByTimeAsync(100)
    expect(added.map(a => a.opts.jobId)).toEqual(['federate-server-update-s1-20', 'federate-server-update-s1-21'])
  })

  it('holds nothing in the process: stopping leaves nothing to queue', async () => {
    vi.useFakeTimers({ now: 100_000 })
    const { l, added, queue } = listener()
    l.handleNotification(update('s1'))
    await vi.advanceTimersByTimeAsync(100)
    expect(added).toHaveLength(1)
    await l.stop()
    expect(queue.add).toHaveBeenCalledTimes(1)
  })
})
