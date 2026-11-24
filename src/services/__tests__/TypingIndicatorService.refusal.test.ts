import { describe, it, expect, vi, beforeEach } from 'vitest'

// A refused typing topic is not retried: each refused join holds the socket for Realtime's
// CHANNEL_ERROR_BACKOFF_MS, default 5 s. Other failures are.

const realtime = vi.hoisted(() => {
  const opened: Array<{ topic: string; status?: (s: string, e?: Error) => void }> = []
  return {
    opened,
    removed: [] as string[],
    channel: (topic: string) => {
      const record: (typeof opened)[number] = { topic }
      opened.push(record)
      const ch: any = {
        topic,
        on: () => ch,
        subscribe: (cb: (s: string, e?: Error) => void) => { record.status = cb; return ch },
        presenceState: () => ({}),
      }
      return ch
    },
  }
})

vi.mock('@/supabase', () => ({
  supabase: { channel: realtime.channel, removeChannel: async (ch: any) => { realtime.removed.push(ch.topic); return 'ok' } },
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'me' } } }) }))
vi.mock('@/services/userDataService', () => ({ userDataService: { getUser: () => null } }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
const tokens = vi.hoisted(() => ({ current: 'member-1', listeners: new Set<(token: string) => void>() }))
vi.mock('@/services/realtimeMemberToken', () => ({
  currentRealtimeToken: () => tokens.current,
  onMemberToken: (listener: (token: string) => void) => {
    tokens.listeners.add(listener)
    return () => tokens.listeners.delete(listener)
  },
}))
/** What auth does on TOKEN_REFRESHED / SIGNED_IN once Realtime holds the token. */
const handOut = (token: string) => {
  tokens.current = token
  for (const listener of [...tokens.listeners]) listener(token)
}

import { typingIndicatorService } from '@/services/TypingIndicatorService'

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

const refused = new Error('"Unauthorized: You do not have permissions to read from this Channel topic: x"')

beforeEach(() => {
  realtime.opened.length = 0
  realtime.removed.length = 0
})

describe('typing channel refusal', () => {
  it('opens a refused topic again on another member token while its view is open', async () => {
    await typingIndicatorService.initialize()
    const off = typingIndicatorService.subscribeToTyping({ type: 'channel', channelId: 'anon' }, () => {})
    await settle()
    realtime.opened[0].status!('CHANNEL_ERROR', refused)
    await settle()

    handOut(tokens.current)
    await settle()
    expect(realtime.opened).toHaveLength(1)

    handOut('member-2')
    await settle()
    expect(realtime.opened).toHaveLength(2)
    expect(realtime.opened[1].topic).toBe(realtime.opened[0].topic)

    realtime.opened[1].status!('CHANNEL_ERROR', refused)
    await settle()
    off()
    handOut('member-3')
    await settle()
    expect(realtime.opened).toHaveLength(2)
  })

  it('opens a refused topic once', async () => {
    await typingIndicatorService.initialize()
    const off = typingIndicatorService.subscribeToTyping({ type: 'channel', channelId: 'refused' }, () => {})
    await settle()
    expect(realtime.opened).toHaveLength(1)

    realtime.opened[0].status!('CHANNEL_ERROR', refused)
    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(realtime.opened).toHaveLength(1)
    off()
  })

  it('removes a joined topic that a rejoin finds refused', async () => {
    await typingIndicatorService.initialize()
    const off = typingIndicatorService.subscribeToTyping({ type: 'channel', channelId: 'kicked' }, () => {})
    await settle()
    realtime.opened[0].status!('SUBSCRIBED')
    await settle()
    expect(realtime.removed).toEqual([])

    realtime.opened[0].status!('CHANNEL_ERROR', refused)
    await settle()

    expect(realtime.removed).toEqual([realtime.opened[0].topic])
    expect(realtime.opened).toHaveLength(1)
    off()
  })

  it('leaves a joined topic to realtime-js after another error', async () => {
    await typingIndicatorService.initialize()
    const off = typingIndicatorService.subscribeToTyping({ type: 'channel', channelId: 'blip' }, () => {})
    await settle()
    realtime.opened[0].status!('SUBSCRIBED')
    await settle()

    realtime.opened[0].status!('CHANNEL_ERROR', new Error('"Realtime is restarting, please standby"'))
    await settle()

    expect(realtime.removed).toEqual([])
    off()
  })

  it('retries a channel that failed otherwise', async () => {
    await typingIndicatorService.initialize()
    const off = typingIndicatorService.subscribeToTyping({ type: 'channel', channelId: 'flaky' }, () => {})
    await settle()
    expect(realtime.opened).toHaveLength(1)

    realtime.opened[0].status!('CHANNEL_ERROR', new Error('"Realtime is initializing the project connection"'))
    await vi.waitFor(() => expect(realtime.opened).toHaveLength(2), { timeout: 2000 })
    realtime.opened[1].status!('SUBSCRIBED')
    off()
  })

  it('opens a joined topic the server closes again, and clears who is typing meanwhile', async () => {
    vi.useFakeTimers()
    try {
      await typingIndicatorService.initialize()
      const seen: number[] = []
      const off = typingIndicatorService.subscribeToTyping({ type: 'channel', channelId: 'closed' }, (users) => seen.push(users.length))
      await vi.advanceTimersByTimeAsync(0)
      realtime.opened[0].status!('SUBSCRIBED')
      await vi.advanceTimersByTimeAsync(0)

      realtime.opened[0].status!('CLOSED')
      expect(seen.at(-1)).toBe(0)
      await vi.advanceTimersByTimeAsync(4_999)
      expect(realtime.opened).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(2_501)
      expect(realtime.opened).toHaveLength(2)
      expect(realtime.opened[1].topic).toBe('typing:channel:closed')
      realtime.opened[1].status!('SUBSCRIBED')
      off()
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens nothing for a closed topic once its view unsubscribes', async () => {
    vi.useFakeTimers()
    try {
      await typingIndicatorService.initialize()
      const off = typingIndicatorService.subscribeToTyping({ type: 'channel', channelId: 'left' }, () => {})
      await vi.advanceTimersByTimeAsync(0)
      realtime.opened[0].status!('SUBSCRIBED')
      await vi.advanceTimersByTimeAsync(0)
      realtime.opened[0].status!('CLOSED')
      off()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(realtime.opened).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps trying a topic that failed five times, while its view is open', async () => {
    vi.useFakeTimers()
    try {
      await typingIndicatorService.initialize()
      const off = typingIndicatorService.subscribeToTyping({ type: 'channel', channelId: 'down' }, () => {})
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(0)
        realtime.opened.at(-1)!.status!('TIMED_OUT')
        await vi.advanceTimersByTimeAsync(500)
      }
      expect(realtime.opened).toHaveLength(5)
      await vi.advanceTimersByTimeAsync(7_500)
      expect(realtime.opened).toHaveLength(6)
      off()
    } finally {
      vi.useRealTimers()
    }
  })
})
