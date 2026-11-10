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

import { typingIndicatorService } from '@/services/TypingIndicatorService'

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

const refused = new Error('"Unauthorized: You do not have permissions to read from this Channel topic: x"')

beforeEach(() => {
  realtime.opened.length = 0
  realtime.removed.length = 0
})

describe('typing channel refusal', () => {
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
})
