import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The voice channel's easter-egg topic outlives a server close (phx_close, reported as CLOSED):
// a new channel is opened and carries activations both ways.

const rpc = vi.hoisted(() => vi.fn(async () => ({ data: null, error: null })))

const rt = vi.hoisted(() => {
  const channels: Array<{
    topic: string
    opts: any
    handlers: Record<string, (p: any) => void>
    status?: (status: string, err?: Error) => void
    sent: any[]
    removed: boolean
  }> = []
  return { channels }
})

vi.mock('@/supabase', () => ({
  supabase: {
    channel: (topic: string, opts: any) => {
      const record: (typeof rt.channels)[number] = { topic, opts, handlers: {}, sent: [], removed: false }
      rt.channels.push(record)
      const ch: any = {
        on: (_type: string, filter: { event: string }, cb: (p: any) => void) => { record.handlers[filter.event] = cb; return ch },
        subscribe: (cb: (status: string, err?: Error) => void) => { record.status = cb; return ch },
        send: async (message: any) => { record.sent.push(message); return 'ok' },
        unsubscribe: async () => 'ok',
        __record: record,
      }
      return ch
    },
    removeChannel: async (ch: any) => { ch.__record.removed = true; return 'ok' },
    rpc,
  },
}))
vi.mock('@/services/realtimeMemberToken', () => ({ currentRealtimeToken: () => 'member-1', onMemberToken: () => () => {} }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { easterEggService } from '@/services/EasterEggService'

const topic = 'easter-egg:voice-1'
const opened = () => rt.channels.filter((c) => c.topic === topic)

beforeEach(() => {
  vi.useFakeTimers()
  easterEggService.cleanup()
  rt.channels.length = 0
})

afterEach(() => {
  easterEggService.cleanup()
  vi.useRealTimers()
})

describe('easter-egg topic', () => {
  it('is private', () => {
    easterEggService.initialize('voice-1', 'me')
    expect(opened()).toHaveLength(1)
    expect(opened()[0].opts.config.private).toBe(true)
  })

  it('opens again after the server closes it, and carries activations both ways', async () => {
    easterEggService.initialize('voice-1', 'me')
    opened()[0].status!('SUBSCRIBED')

    opened()[0].status!('CLOSED')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(opened()).toHaveLength(2)
    const next = opened()[1]
    next.status!('SUBSCRIBED')

    next.handlers.activate({ payload: { type: 'rainbow-party', userId: 'peer' } })
    expect(easterEggService.getState()).toMatchObject({ isActive: true, type: 'rainbow-party', activatedBy: 'peer' })

    // Sent through send_signal (20261124100001), which names the member.
    easterEggService.deactivate()
    expect(rpc).toHaveBeenCalledWith('send_signal', { p_topic: topic, p_event: 'deactivate', p_payload: {} })
  })

  it('closes for good on cleanup: no rebuild follows', async () => {
    easterEggService.initialize('voice-1', 'me')
    const first = opened()[0]
    easterEggService.cleanup()
    first.status!('CLOSED')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(opened()).toHaveLength(1)
  })
})
