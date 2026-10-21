/**
 * A channel Realtime refuses ("Unauthorized: You do not have permissions to read from this
 * Channel topic") is removed and not retried: realtime-js would otherwise rejoin it on its own
 * timer, and the manager's backoff would rebuild it, both without end. Other errors still retry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const rt = vi.hoisted(() => {
  const channels: Array<{ name: string; emit: (s: string, err?: Error) => void; removed: boolean }> = []
  const supabase = {
    channel: vi.fn((name: string) => {
      const entry = { name, emit: (_s: string, _err?: Error) => {}, removed: false }
      const ch: any = {
        on: () => ch,
        subscribe: (cb: (s: string, err?: Error) => void) => {
          entry.emit = cb
          return ch
        },
        __entry: entry,
      }
      channels.push(entry)
      return ch
    }),
    removeChannel: vi.fn((ch: any) => {
      ch.__entry.removed = true
      // realtime-js closes an unjoined channel inline.
      ch.__entry.emit('CLOSED')
      return Promise.resolve('ok')
    }),
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) },
  }
  return { channels, supabase }
})

vi.mock('@/supabase', () => ({ supabase: rt.supabase }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { RealtimeConnectionManagerService } from '@/services/RealtimeConnectionManager'

const REFUSAL = 'Unauthorized: You do not have permissions to read from this Channel topic: server-events:s1'
const NAME = 'server-events:s1'

let manager: RealtimeConnectionManagerService
const live = () => rt.channels[rt.channels.length - 1]

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  rt.channels.length = 0
  rt.supabase.channel.mockClear()
  rt.supabase.removeChannel.mockClear()
  manager = new RealtimeConnectionManagerService()
})

afterEach(() => {
  manager.cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('RealtimeConnectionManager and a refused channel', () => {
  it('removes the channel, records the refusal and schedules nothing', async () => {
    const onStatusChange = vi.fn()
    manager.subscribeBroadcast({ channelName: NAME, broadcasts: [{ event: 'x', handler: vi.fn() }], onStatusChange })
    const refused = live()
    refused.emit('CHANNEL_ERROR', new Error(REFUSAL))

    expect(refused.removed).toBe(true)
    expect(manager.getSubscriptionStatus(NAME)).toBe('error')
    expect(manager.getAllStatuses().get(NAME)?.lastError).toBe(REFUSAL)
    expect(onStatusChange).toHaveBeenLastCalledWith('error', NAME)

    // The health check runs every 60 s.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(rt.supabase.channel).toHaveBeenCalledTimes(1)
    expect(manager.getSubscriptionStatus(NAME)).toBe('error')
  })

  it('a refusal once the backoff ran out is not retried by the health check either', async () => {
    manager.subscribeBroadcast({ channelName: NAME, broadcasts: [{ event: 'x', handler: vi.fn() }] })
    for (let i = 0; i < 10; i++) {
      live().emit('CHANNEL_ERROR', new Error('timeout'))
      await vi.advanceTimersByTimeAsync(30_000)
    }
    expect(rt.supabase.channel).toHaveBeenCalledTimes(11)

    live().emit('CHANNEL_ERROR', new Error(REFUSAL))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(rt.supabase.channel).toHaveBeenCalledTimes(11)
  })

  it('still retries any other channel error', async () => {
    manager.subscribeBroadcast({ channelName: NAME, broadcasts: [{ event: 'x', handler: vi.fn() }] })
    live().emit('CHANNEL_ERROR', new Error('timeout'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(rt.supabase.channel).toHaveBeenCalledTimes(2)
  })

  it('a forced reconnect (online, visibility) opens a refused channel again', () => {
    manager.subscribeBroadcast({ channelName: NAME, broadcasts: [{ event: 'x', handler: vi.fn() }] })
    live().emit('CHANNEL_ERROR', new Error(REFUSAL))
    manager.forceReconnect(NAME)
    expect(rt.supabase.channel).toHaveBeenCalledTimes(2)
    live().emit('SUBSCRIBED')
    expect(manager.getSubscriptionStatus(NAME)).toBe('connected')
  })
})
