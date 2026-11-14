import { describe, it, expect, vi } from 'vitest'

// federate-server-update reads its server as it is when it runs: the notifications one commit
// sends for many rows of a server queue one job.

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

describe('NotificationListener batch', () => {
  it('queues one federate-server-update per server, and every other job as sent', async () => {
    const { l, added } = listener()
    for (let i = 0; i < 5; i++) l.handleNotification(note('federate-server-update', { type: 'update', server_id: 's1' }))
    l.handleNotification(note('federate-server-update', { type: 'update', server_id: 's2' }))
    l.handleNotification(note('federate-channel-pin', { type: 'update', server_id: 's1', message_id: 'm1' }))
    l.handleNotification(note('federate-channel-pin', { type: 'update', server_id: 's1', message_id: 'm2' }))
    await vi.waitFor(() => expect(added).toHaveLength(4))
    expect(added.filter(([n]) => n === 'federate-server-update').map(([, d]) => d.server_id).sort()).toEqual(['s1', 's2'])
    expect(added.filter(([n]) => n === 'federate-channel-pin')).toHaveLength(2)
  })

  it('queues the same server again in a later batch', async () => {
    const { l, added } = listener()
    l.handleNotification(note('federate-server-update', { type: 'update', server_id: 's1' }))
    await vi.waitFor(() => expect(added).toHaveLength(1))
    l.handleNotification(note('federate-server-update', { type: 'update', server_id: 's1' }))
    await vi.waitFor(() => expect(added).toHaveLength(2))
  })
})
