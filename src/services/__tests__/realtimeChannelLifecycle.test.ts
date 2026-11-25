import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RealtimeClient, type RealtimeChannel } from '@supabase/realtime-js'

// realtime-js against a scripted Phoenix server, vsn 1.0.0 frames.
//
// realtime-js 2.84 re-armed the rejoin timer on every tick: a join reply slower than the rejoin
// delay (1, 2, 5 s) met a rejoin that left the channel's own topic and dropped the channel from
// the socket, so the late reply reached nothing and the channel stayed `joining`. A server
// `phx_close` ends a channel for good in every version; openRebuildingChannel opens it again.

type Frame = { topic: string; event: string; payload: any; ref: string | null; join_ref: string | null }

const wire = vi.hoisted(() => {
  class FakeSocket {
    static sockets: FakeSocket[] = []
    readyState = 0
    bufferedAmount = 0
    binaryType = 'arraybuffer'
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: ((event: { code: number; wasClean: boolean }) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    sent: Frame[] = []
    constructor(public url: string) {
      FakeSocket.sockets.push(this)
    }
    send(data: string) {
      this.sent.push(JSON.parse(data))
    }
    close(code = 1000) {
      this.readyState = 3
      this.onclose?.({ code, wasClean: true })
    }
    open() {
      this.readyState = 1
      this.onopen?.()
    }
    /** Transport loss without a close frame. */
    drop() {
      this.readyState = 3
      this.onclose?.({ code: 1006, wasClean: false })
    }
    deliver(frame: Frame) {
      this.onmessage?.({ data: JSON.stringify(frame) })
    }
    joins(topic: string) {
      return this.sent.filter((f) => f.event === 'phx_join' && f.topic === topic)
    }
    reply(join: Frame, status: 'ok' | 'error' = 'ok', response: Record<string, unknown> = {}) {
      this.deliver({ topic: join.topic, event: 'phx_reply', payload: { status, response }, ref: join.ref, join_ref: join.ref })
    }
    /** What Realtime sends when it stops a channel process (events limit, expired token). */
    closeChannel(join: Frame) {
      this.deliver({ topic: join.topic, event: 'phx_close', payload: {}, ref: join.ref, join_ref: join.ref })
    }
  }
  return { FakeSocket, client: null as unknown as RealtimeClient }
})

vi.mock('@/supabase', () => ({
  supabase: {
    channel: (topic: string, opts: any) => wire.client.channel(topic, opts),
    removeChannel: (channel: RealtimeChannel) => wire.client.removeChannel(channel),
  },
}))
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

import { openRebuildingChannel } from '@/services/rebuildingChannel'

const { FakeSocket } = wire
const socket = (i: number) => FakeSocket.sockets[i]

function newClient(): RealtimeClient {
  return new RealtimeClient('ws://realtime.test/realtime/v1', {
    params: { apikey: 'anon' },
    transport: FakeSocket as any,
    vsn: '1.0.0',
    heartbeatIntervalMs: 3_600_000,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.sockets.length = 0
  tokens.current = 'member-1'
  tokens.listeners.clear()
  wire.client = newClient()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('realtime-js channel lifecycle', () => {
  it('keeps a channel whose join reply arrives after the rejoin delays', async () => {
    const topic = 'realtime:user:me'
    const statuses: string[] = []
    const ch = wire.client.channel('user:me', { config: { private: true } })
    ch.subscribe((s) => statuses.push(s))
    socket(0).open()
    socket(0).reply(socket(0).joins(topic)[0])
    expect(statuses).toEqual(['SUBSCRIBED'])

    socket(0).drop()
    await vi.advanceTimersByTimeAsync(1_000)
    socket(1).open()
    const pending = socket(1).joins(topic)
    expect(pending).toHaveLength(1)

    // Past the 1, 2 and 5 s rejoin delays, under the 10 s join timeout.
    await vi.advanceTimersByTimeAsync(9_000)
    expect(wire.client.getChannels()).toContain(ch)
    expect(socket(1).joins(topic)).toHaveLength(1)

    socket(1).reply(pending[0])
    expect(ch.state).toBe('joined')
    expect(statuses.at(-1)).toBe('SUBSCRIBED')
  })

  it('joins again on the same channel after a join times out', async () => {
    const topic = 'realtime:user:me'
    const ch = wire.client.channel('user:me', { config: { private: true } })
    ch.subscribe()
    socket(0).open()
    await vi.advanceTimersByTimeAsync(10_000 + 1_000)
    const joins = socket(0).joins(topic)
    expect(joins).toHaveLength(2)
    expect(wire.client.getChannels()).toContain(ch)
    socket(0).reply(joins[1])
    expect(ch.state).toBe('joined')
  })

  it('ends a channel the server closes: CLOSED, off the client, never joined again', async () => {
    const topic = 'realtime:server-structure:s1'
    const statuses: string[] = []
    const keep = wire.client.channel('user:me', { config: { private: true } })
    keep.subscribe()
    const ch = wire.client.channel('server-structure:s1', { config: { private: true } })
    ch.subscribe((s) => statuses.push(s))
    socket(0).open()
    socket(0).reply(socket(0).joins(topic)[0])

    socket(0).closeChannel(socket(0).joins(topic)[0])

    expect(statuses).toEqual(['SUBSCRIBED', 'CLOSED'])
    expect(wire.client.getChannels()).not.toContain(ch)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(socket(0).joins(topic)).toHaveLength(1)
  })
})

describe('openRebuildingChannel on realtime-js', () => {
  const topic = 'realtime:server-structure:s1'
  const broadcast = (join: { ref: string | null }, payload: Record<string, unknown>) => socket(0).deliver({
    topic, event: 'broadcast', payload: { type: 'broadcast', event: 'server_event', payload }, ref: null, join_ref: join.ref,
  })

  it('joins a topic the server closed again, as a new channel that delivers, and reports the gap', async () => {
    const seen: unknown[] = []
    const resumed: boolean[] = []
    const t = openRebuildingChannel({
      topic: 'server-structure:s1',
      bind: (ch) => ch.on('broadcast', { event: 'server_event' }, (m) => seen.push(m.payload)),
      onSubscribed: (r) => resumed.push(r),
    })
    socket(0).open()
    const first = socket(0).joins(topic)[0]
    expect(first.payload.config.private).toBe(true)
    socket(0).reply(first)
    expect(resumed).toEqual([false])

    socket(0).closeChannel(first)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(socket(0).joins(topic)).toHaveLength(1)
    // channelRetryDelay(0) plus at most half of it.
    await vi.advanceTimersByTimeAsync(2_501)
    const second = socket(0).joins(topic)[1]
    expect(second).toBeDefined()
    expect(second.ref).not.toBe(first.ref)
    socket(0).reply(second)
    expect(resumed).toEqual([false, true])

    broadcast(second, { type: 'channel:insert' })
    expect(seen).toEqual([{ type: 'channel:insert' }])

    await t.close()
    expect(socket(0).sent.filter((f) => f.event === 'phx_leave' && f.topic === topic)).toHaveLength(1)
    socket(0).closeChannel(second)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(socket(0).joins(topic)).toHaveLength(2)
  })

  // supabase.channel() returns the instance still listed for a topic, and subscribe() on one that
  // joined before sends nothing. leave() marks the channel leaving before its canPush() check, so
  // the leave resolves inline and the instance is off the list before close() returns.
  it('joins a new channel when the topic is closed and opened in one tick', async () => {
    const first = openRebuildingChannel({ topic: 'server-structure:s1', bind: () => {} })
    socket(0).open()
    socket(0).reply(socket(0).joins(topic)[0])

    void first.close()
    const resumed: boolean[] = []
    openRebuildingChannel({ topic: 'server-structure:s1', bind: () => {}, onSubscribed: (r) => resumed.push(r) })
    const joins = socket(0).joins(topic)
    expect(joins).toHaveLength(2)
    socket(0).reply(joins[1])
    expect(resumed).toEqual([false])
    expect(wire.client.getChannels().filter((c) => c.topic === topic)).toHaveLength(1)
  })

  const refuse = (join: Frame) => socket(0).reply(join, 'error', {
    reason: 'Unauthorized: You do not have permissions to read from this Channel topic: server-structure:s1',
  })

  it('stops a refused topic until auth hands out another member token', async () => {
    const refused: string[] = []
    const resumed: boolean[] = []
    openRebuildingChannel({
      topic: 'server-structure:s1',
      bind: () => {},
      onSubscribed: (r) => resumed.push(r),
      onRefused: (err) => refused.push(String(err?.message)),
    })
    socket(0).open()
    refuse(socket(0).joins(topic)[0])
    expect(refused).toHaveLength(1)
    expect(wire.client.getChannels()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(socket(0).joins(topic)).toHaveLength(1)

    handOut('member-1')
    expect(socket(0).joins(topic)).toHaveLength(1)

    handOut('member-2')
    const joins = socket(0).joins(topic)
    expect(joins).toHaveLength(2)
    socket(0).reply(joins[1])
    expect(resumed).toEqual([true])
  })

  it('opens no closed topic on another member token', async () => {
    const t = openRebuildingChannel({ topic: 'server-structure:s1', bind: () => {} })
    socket(0).open()
    refuse(socket(0).joins(topic)[0])
    await t.close()
    expect(tokens.listeners.size).toBe(0)
    handOut('member-2')
    expect(socket(0).joins(topic)).toHaveLength(1)
  })

  it('sends on the current channel, and nothing while the topic is down', async () => {
    const t = openRebuildingChannel({ topic: 'server-structure:s1', bind: () => {} })
    socket(0).open()
    const first = socket(0).joins(topic)[0]
    socket(0).reply(first)
    const message = { type: 'broadcast' as const, event: 'voice-channel-event', payload: { event: 'request-state' } }
    void t.send(message)
    expect(socket(0).sent.filter((f) => f.event === 'broadcast' && f.topic === topic)).toHaveLength(1)

    socket(0).closeChannel(first)
    await expect(t.send(message)).resolves.toBe('error')
    expect(socket(0).sent.filter((f) => f.event === 'broadcast' && f.topic === topic)).toHaveLength(1)
  })
})
