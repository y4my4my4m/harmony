import { describe, it, expect, vi, afterEach } from 'vitest'

// federate-server-update reads its server as it is when it runs: the notifications of five seconds
// for one server queue one job at the window's end, whether they came in one commit or many.

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../services/FederationSwitches.js', () => ({ invalidateFederationSwitches: vi.fn() }))

const { NotificationListener } = await import('../queue/NotificationListener.js')

function listener() {
  const added: Array<[string, any]> = []
  const queue = { add: vi.fn(async (name: string, data: any) => { added.push([name, data]) }) }
  const l: any = new NotificationListener('postgres://unused', () => queue as any)
  return { l, added }
}

const note = (name: string, data: Record<string, unknown>) =>
  JSON.stringify({ name, id: crypto.randomUUID(), data })
const update = (serverId: string) => note('federate-server-update', { type: 'update', server_id: serverId })

afterEach(() => {
  vi.useRealTimers()
})

describe('NotificationListener collapsing', () => {
  it('queues one federate-server-update per server for a window of commits, and other jobs at once', async () => {
    vi.useFakeTimers()
    const { l, added } = listener()
    for (let i = 0; i < 5; i++) {
      l.handleNotification(update('s1'))
      await vi.advanceTimersByTimeAsync(400)
    }
    l.handleNotification(update('s2'))
    l.handleNotification(note('federate-channel-pin', { type: 'update', server_id: 's1', message_id: 'm1' }))
    l.handleNotification(note('federate-channel-pin', { type: 'update', server_id: 's1', message_id: 'm2' }))
    await vi.advanceTimersByTimeAsync(100)
    expect(added.map(([n]) => n)).toEqual(['federate-channel-pin', 'federate-channel-pin'])

    await vi.advanceTimersByTimeAsync(5_000)
    expect(added.filter(([n]) => n === 'federate-server-update').map(([, d]) => d.server_id).sort()).toEqual(['s1', 's2'])
  })

  it('opens a new window for a change after the job was queued', async () => {
    vi.useFakeTimers()
    const { l, added } = listener()
    l.handleNotification(update('s1'))
    await vi.advanceTimersByTimeAsync(5_100)
    expect(added).toHaveLength(1)
    l.handleNotification(update('s1'))
    await vi.advanceTimersByTimeAsync(5_100)
    expect(added).toHaveLength(2)
  })

  it('queues what waits when it stops', async () => {
    vi.useFakeTimers()
    const { l, added } = listener()
    l.handleNotification(update('s1'))
    await vi.advanceTimersByTimeAsync(100)
    expect(added).toHaveLength(0)
    await l.stop()
    expect(added.map(([, d]) => d.server_id)).toEqual(['s1'])
  })
})
