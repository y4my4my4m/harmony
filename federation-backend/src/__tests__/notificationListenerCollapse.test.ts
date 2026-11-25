import { describe, it, expect, vi, afterEach } from 'vitest'

// federate-server-update reads its server as it is when it runs: one pending job per server, due
// five seconds after the first notification. A notification while the job waits is absorbed; one
// while it runs queues one more job after it, whatever the listener's and the worker's clocks say.

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../services/FederationSwitches.js', () => ({ invalidateFederationSwitches: vi.fn() }))

const { NotificationListener, collapsedJob } = await import('../queue/NotificationListener.js')

interface FakeJob { id: number; name: string; data: any; opts: any; state: 'delayed' | 'active' | 'completed' }

// A queue as BullMQ 5 keeps one: a job id it holds is ignored, completed jobs included; a
// deduplication id held by a pending job is ignored, and with keepLastIfActive one held by an
// active job stores the add, which becomes a job when the active one finishes.
function listener() {
  const jobs: FakeJob[] = []
  const ids = new Set<string>()
  const dedup = new Map<string, FakeJob>()
  const next = new Map<string, { name: string; data: any; opts: any }>()
  let seq = 0
  const create = (name: string, data: any, opts: any) => {
    const job: FakeJob = { id: ++seq, name, data, opts, state: 'delayed' }
    jobs.push(job)
    if (opts?.deduplication) dedup.set(opts.deduplication.id, job)
    return job
  }
  const queue = {
    add: vi.fn(async (name: string, data: any, opts: any) => {
      if (opts?.jobId) {
        if (ids.has(opts.jobId)) return
        ids.add(opts.jobId)
      }
      const key = opts?.deduplication?.id
      const holder = key ? dedup.get(key) : undefined
      if (holder) {
        if (holder.state === 'active' && opts.deduplication.keepLastIfActive) next.set(key, { name, data, opts })
        return
      }
      create(name, data, opts)
    }),
  }
  const start = (job: FakeJob) => { job.state = 'active' }
  const finish = (job: FakeJob) => {
    job.state = 'completed'
    const key = job.opts?.deduplication?.id
    if (!key || dedup.get(key) !== job) return
    dedup.delete(key)
    const stored = next.get(key)
    if (stored) {
      next.delete(key)
      create(stored.name, stored.data, stored.opts)
    }
  }
  const l: any = new NotificationListener('postgres://unused', () => queue as any)
  return { l, jobs, queue, start, finish }
}

const note = (name: string, data: Record<string, unknown>) =>
  JSON.stringify({ name, id: crypto.randomUUID(), data })
const update = (serverId: string) => note('federate-server-update', { type: 'update', server_id: serverId })
const updates = (jobs: FakeJob[]) => jobs.filter(j => j.name === 'federate-server-update')

afterEach(() => {
  vi.useRealTimers()
})

describe('collapsedJob', () => {
  it('names the server, is due five seconds on, and keeps one add made while the job runs', () => {
    const n = { name: 'federate-server-update', data: { server_id: 's1' } }
    expect(collapsedJob(n)).toEqual({ delay: 5_000, deduplication: { id: 'federate-server-update-s1', keepLastIfActive: true } })
    expect(collapsedJob({ name: 'federate-channel-pin', data: { server_id: 's1' } })).toBeNull()
    expect(collapsedJob({ name: 'federate-server-update', data: {} })).toBeNull()
  })
})

describe('NotificationListener collapsing', () => {
  it('queues one delayed federate-server-update per server, and other jobs at once', async () => {
    vi.useFakeTimers({ now: 100_000 })
    const { l, jobs } = listener()
    for (let i = 0; i < 5; i++) {
      l.handleNotification(update('s1'))
      await vi.advanceTimersByTimeAsync(400)
    }
    l.handleNotification(update('s2'))
    l.handleNotification(note('federate-channel-pin', { type: 'update', server_id: 's1', message_id: 'm1' }))
    l.handleNotification(note('federate-channel-pin', { type: 'update', server_id: 's1', message_id: 'm2' }))
    await vi.advanceTimersByTimeAsync(100)

    const pins = jobs.filter(j => j.name === 'federate-channel-pin')
    expect(pins).toHaveLength(2)
    expect(pins.every(j => j.opts.jobId === undefined && j.opts.delay === undefined && j.opts.deduplication === undefined)).toBe(true)
    expect(updates(jobs).map(j => [j.data.server_id, j.opts.deduplication.id, j.opts.delay])).toEqual([
      ['s1', 'federate-server-update-s1', 5_000],
      ['s2', 'federate-server-update-s2', 5_000],
    ])
    expect(updates(jobs)[0].opts.attempts).toBe(5)
  })

  it('queues one more job for a change made while the job runs, whatever the worker\'s clock', async () => {
    // The worker's clock runs ahead of the listener's: it takes the job two seconds after the
    // first notification, before the listener's five seconds are up.
    vi.useFakeTimers({ now: 100_000 })
    const { l, jobs, start, finish } = listener()
    l.handleNotification(update('s1'))
    await vi.advanceTimersByTimeAsync(2_000)
    start(updates(jobs)[0])
    l.handleNotification(update('s1'))
    await vi.advanceTimersByTimeAsync(1_000)
    l.handleNotification(update('s1'))
    await vi.advanceTimersByTimeAsync(100)
    expect(updates(jobs)).toHaveLength(1)

    finish(updates(jobs)[0])
    expect(updates(jobs)).toHaveLength(2)
    expect(updates(jobs)[1]).toMatchObject({ state: 'delayed', opts: { delay: 5_000 } })
  })

  it('a change after the job finished queues the next job', async () => {
    vi.useFakeTimers({ now: 100_000 })
    const { l, jobs, start, finish } = listener()
    l.handleNotification(update('s1'))
    await vi.advanceTimersByTimeAsync(5_100)
    start(updates(jobs)[0])
    finish(updates(jobs)[0])
    l.handleNotification(update('s1'))
    await vi.advanceTimersByTimeAsync(100)
    expect(updates(jobs).map(j => j.state)).toEqual(['completed', 'delayed'])
  })

  it('holds nothing in the process: stopping leaves nothing to queue', async () => {
    vi.useFakeTimers({ now: 100_000 })
    const { l, jobs, queue } = listener()
    l.handleNotification(update('s1'))
    await vi.advanceTimersByTimeAsync(100)
    expect(jobs).toHaveLength(1)
    await l.stop()
    expect(queue.add).toHaveBeenCalledTimes(1)
  })
})
