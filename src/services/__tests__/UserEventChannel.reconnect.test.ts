/**
 * user:{profileId} channel lifecycle: retries without a ceiling, ignores
 * callbacks of channels it replaced, resyncs (`_reconnected`) after every
 * drop, and rebuilds on `online` or a long-hidden tab turning visible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Status = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED'

const rt = vi.hoisted(() => {
  const channels: Array<{ topic: string; emit: (s: string) => void; removed: boolean }> = []
  const supabase = {
    channel: vi.fn((topic: string) => {
      const entry = { topic, emit: (_s: string) => {}, removed: false }
      const ch: any = {
        on: () => ch,
        subscribe: (cb: (s: string) => void) => {
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
    }),
  }
  return { channels, supabase }
})

vi.mock('@/supabase', () => ({ supabase: rt.supabase }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { userEventChannel } from '@/services/UserEventChannel'

const live = () => rt.channels[rt.channels.length - 1]
const emit = (s: Status) => live().emit(s)

let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  rt.channels.length = 0
  rt.supabase.channel.mockClear()
  rt.supabase.removeChannel.mockClear()
})

afterEach(() => {
  userEventChannel.disconnect()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('UserEventChannel reconnect', () => {
  it('keeps retrying past the former 12-attempt ceiling', async () => {
    userEventChannel.connect('p1')
    emit('SUBSCRIBED')
    for (let i = 0; i < 20; i++) {
      emit('CHANNEL_ERROR')
      await vi.advanceTimersByTimeAsync(30_000)
    }
    expect(rt.supabase.channel).toHaveBeenCalledTimes(21)
    emit('SUBSCRIBED')
    expect(userEventChannel.isConnected).toBe(true)
  })

  it('dispatches _reconnected on the SUBSCRIBED after a drop, once', async () => {
    const resync = vi.fn()
    userEventChannel.on('_reconnected', resync)
    userEventChannel.connect('p1')
    emit('SUBSCRIBED')
    expect(resync).not.toHaveBeenCalled()

    emit('TIMED_OUT')
    await vi.advanceTimersByTimeAsync(2_000)
    emit('SUBSCRIBED')
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it('resyncs when realtime-js rejoins the same channel before the backoff fires', async () => {
    const resync = vi.fn()
    userEventChannel.on('_reconnected', resync)
    userEventChannel.connect('p1')
    emit('SUBSCRIBED')

    emit('CHANNEL_ERROR')
    emit('SUBSCRIBED')
    expect(resync).toHaveBeenCalledTimes(1)

    // The pending rebuild is cancelled: the rejoined channel stays.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rt.supabase.channel).toHaveBeenCalledTimes(1)
  })

  it('ignores the CLOSED of a channel it replaced', async () => {
    userEventChannel.connect('p1')
    emit('SUBSCRIBED')
    emit('CHANNEL_ERROR')
    await vi.advanceTimersByTimeAsync(2_000)
    const first = rt.channels[0]
    expect(first.removed).toBe(true)
    emit('SUBSCRIBED')

    first.emit('CLOSED')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(userEventChannel.isConnected).toBe(true)
    expect(rt.supabase.channel).toHaveBeenCalledTimes(2)
  })

  it('a second connect for the same user while joining keeps the channel', () => {
    userEventChannel.connect('p1')
    userEventChannel.connect('p1')
    expect(rt.supabase.channel).toHaveBeenCalledTimes(1)
  })

  it('rebuilds on online and resyncs', async () => {
    const resync = vi.fn()
    userEventChannel.on('_reconnected', resync)
    userEventChannel.connect('p1')
    emit('SUBSCRIBED')

    window.dispatchEvent(new Event('online'))
    expect(rt.supabase.channel).toHaveBeenCalledTimes(2)
    emit('SUBSCRIBED')
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it('rebuilds when a tab hidden for a minute turns visible, not after a short alt-tab', async () => {
    userEventChannel.connect('p1')
    emit('SUBSCRIBED')

    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(5_000)
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(rt.supabase.channel).toHaveBeenCalledTimes(1)

    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(61_000)
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(rt.supabase.channel).toHaveBeenCalledTimes(2)
  })

  it('reconnects at once on visibility when the channel is down', async () => {
    userEventChannel.connect('p1')
    emit('SUBSCRIBED')
    emit('CHANNEL_ERROR')
    expect(rt.supabase.channel).toHaveBeenCalledTimes(1)

    document.dispatchEvent(new Event('visibilitychange'))
    expect(rt.supabase.channel).toHaveBeenCalledTimes(2)
  })
})
