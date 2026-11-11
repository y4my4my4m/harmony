/**
 * A channel Realtime refuses ("Unauthorized: You do not have permissions to read from this
 * Channel topic") is removed and not retried: realtime-js would otherwise rejoin it on its own
 * timer, and the manager's backoff would rebuild it, both without end. Other errors still retry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type AuthCallback = (event: string, session: { access_token: string } | null) => void

const rt = vi.hoisted(() => {
  const authListeners: AuthCallback[] = []
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
    auth: {
      onAuthStateChange: (cb: AuthCallback) => {
        authListeners.push(cb)
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
    },
    realtime: {
      accessTokenValue: 'anon-key' as string,
      setAuth: vi.fn(async (token: string) => {
        supabase.realtime.accessTokenValue = token
      }),
    },
  }
  return { channels, supabase, authListeners }
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
  rt.supabase.realtime.accessTokenValue = 'anon-key'
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

// supabase-js 2.84 hands Realtime the anon key while a token refresh fails; Realtime refuses every
// private topic on it. The refresh that succeeds later emits TOKEN_REFRESHED with a member token.
describe('RealtimeConnectionManager, a refused channel and the next member token', () => {
  // supabase-js's own listener, registered first, hands the token to realtime.setAuth.
  const authEvent = (event: string, token: string) => {
    rt.supabase.realtime.accessTokenValue = token
    for (const cb of rt.authListeners) cb(event, { access_token: token })
  }

  it('opens a channel refused on the anon key again once a member token arrives', async () => {
    manager.initialize()
    const onStatusChange = vi.fn()
    manager.subscribeBroadcast({ channelName: NAME, broadcasts: [{ event: 'x', handler: vi.fn() }], onStatusChange })
    live().emit('CHANNEL_ERROR', new Error(REFUSAL))
    expect(rt.supabase.channel).toHaveBeenCalledTimes(1)

    authEvent('TOKEN_REFRESHED', 'member-2')
    await vi.advanceTimersByTimeAsync(0)
    expect(rt.supabase.channel).toHaveBeenCalledTimes(2)
    live().emit('SUBSCRIBED')
    expect(manager.getSubscriptionStatus(NAME)).toBe('connected')
    expect(onStatusChange).toHaveBeenLastCalledWith('connected', NAME)
  })

  it('keeps a channel refused on the member token closed when that token comes again', async () => {
    rt.supabase.realtime.accessTokenValue = 'member-1'
    manager.initialize()
    manager.subscribeBroadcast({ channelName: NAME, broadcasts: [{ event: 'x', handler: vi.fn() }] })
    live().emit('CHANNEL_ERROR', new Error(REFUSAL))

    authEvent('SIGNED_IN', 'member-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(rt.supabase.channel).toHaveBeenCalledTimes(1)
    expect(manager.getSubscriptionStatus(NAME)).toBe('error')
  })

  it('rebuilds nothing when Realtime holds another token by dispatch, as after a sign-out', async () => {
    manager.initialize()
    manager.subscribeBroadcast({ channelName: NAME, broadcasts: [{ event: 'x', handler: vi.fn() }] })
    live().emit('CHANNEL_ERROR', new Error(REFUSAL))

    authEvent('TOKEN_REFRESHED', 'member-2')
    rt.supabase.realtime.accessTokenValue = 'anon-key'
    await vi.advanceTimersByTimeAsync(0)
    expect(rt.supabase.channel).toHaveBeenCalledTimes(1)
  })

  it('leaves a joined channel alone on a refresh', async () => {
    manager.initialize()
    manager.subscribeBroadcast({ channelName: NAME, broadcasts: [{ event: 'x', handler: vi.fn() }] })
    live().emit('SUBSCRIBED')

    authEvent('TOKEN_REFRESHED', 'member-2')
    await vi.advanceTimersByTimeAsync(0)
    expect(rt.supabase.channel).toHaveBeenCalledTimes(1)
    expect(manager.getSubscriptionStatus(NAME)).toBe('connected')
  })
})
