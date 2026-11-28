import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RealtimeClient, type RealtimeChannel } from '@supabase/realtime-js'

// The call topics against realtime-js and a scripted Phoenix server (vsn 1.0.0 frames), as
// realtimeChannelLifecycle.test.ts. A server phx_close ends a channel for good in realtime-js:
// harmony-voice-<room> (P2P signals) and dm-call:<conversation> (call signals and presence) are
// joined again as new channels after a backoff. A topic this client leaves stays left.

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
    deliver(frame: Frame) {
      this.onmessage?.({ data: JSON.stringify(frame) })
    }
    joins(topic: string) {
      return this.sent.filter((f) => f.event === 'phx_join' && f.topic === topic)
    }
    reply(join: Frame) {
      this.deliver({ topic: join.topic, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: join.ref, join_ref: join.ref })
    }
    closeChannel(join: Frame) {
      this.deliver({ topic: join.topic, event: 'phx_close', payload: {}, ref: join.ref, join_ref: join.ref })
    }
  }
  return { FakeSocket, client: null as unknown as RealtimeClient, rpc: null as unknown as ReturnType<typeof vi.fn> }
})

vi.mock('@/supabase', () => ({
  supabase: {
    channel: (topic: string, opts: any) => wire.client.channel(topic, opts),
    removeChannel: (channel: RealtimeChannel) => wire.client.removeChannel(channel),
    rpc: (...args: unknown[]) => wire.rpc(...args),
  },
}))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/services/realtimeMemberToken', () => ({
  currentRealtimeToken: () => 'member-1',
  onMemberToken: () => () => {},
}))
const profile = vi.hoisted(() => ({ read: async () => 'me' as string | null }))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentProfileId: () => profile.read() },
}))

import { UnifiedWebRTCService } from '../unifiedWebRTC'
import { dmCallSignaling } from '../DMCallSignaling'

const { FakeSocket } = wire
const socket = () => FakeSocket.sockets[0]
// ChannelCloseBackoff: channelRetryDelay(0) is 5 s, plus at most half of it.
const BACKOFF_MS = 7_501

class FakePeerConnection {
  connectionState = 'new'
  iceConnectionState = 'new'
  signalingState = 'stable'
  remoteDescription = null
  constructor(public config: RTCConfiguration) {}
  addTrack() {}
  createOffer = async () => ({ type: 'offer', sdp: 'v=0' })
  setLocalDescription = async () => {}
  close() {}
}

beforeEach(() => {
  vi.useFakeTimers()
  profile.read = async () => 'me'
  FakeSocket.sockets.length = 0
  wire.rpc = vi.fn(async () => ({ data: null, error: null }))
  wire.client = new RealtimeClient('ws://realtime.test/realtime/v1', {
    params: { apikey: 'anon' },
    transport: FakeSocket as any,
    vsn: '1.0.0',
    heartbeatIntervalMs: 3_600_000,
  })
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
})

afterEach(() => {
  dmCallSignaling.cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('P2P signalling topic', () => {
  const topic = 'realtime:harmony-voice-room-1'
  const relayed = (join: Frame, from: string, messages: unknown[]) => socket().deliver({
    topic, event: 'broadcast', payload: { type: 'broadcast', event: 'signals', payload: { from, messages } }, ref: null, join_ref: join.ref,
  })

  function joining() {
    const svc = new UnifiedWebRTCService()
    const s = svc as any
    s.channelId = 'room-1'
    s.currentUserId = 'me'
    const ready = s.setupSignaling() as Promise<void>
    socket().open()
    return { svc, s, ready }
  }

  it('is joined again after a server close, asks the room for its state, and offers to a member it missed', async () => {
    const { s, ready } = joining()
    const first = socket().joins(topic)[0]
    expect(first.payload.config.private).toBe(true)
    socket().reply(first)
    await ready

    socket().closeChannel(first)
    await vi.advanceTimersByTimeAsync(BACKOFF_MS)
    const second = socket().joins(topic)[1]
    expect(second).toBeDefined()
    socket().reply(second)
    await vi.advanceTimersByTimeAsync(0)

    expect(wire.rpc).toHaveBeenCalledWith('send_signal', {
      p_topic: 'harmony-voice-room-1',
      p_event: 'signals',
      p_payload: { messages: [expect.objectContaining({ type: 'state-sync', data: { action: 'request' } })] },
    })

    // A member who joined during the gap answers; its user-joined never arrived here.
    relayed(second, 'late', [{ type: 'state-sync', to: 'me', data: { action: 'response', mediaState: { userId: 'late' } } }])
    await vi.advanceTimersByTimeAsync(0)
    expect(s.connections.has('late')).toBe(true)
    expect(wire.rpc).toHaveBeenCalledWith('send_signal', {
      p_topic: 'harmony-voice-room-1',
      p_event: 'signals',
      p_payload: { messages: [expect.objectContaining({ type: 'offer', to: 'late' })] },
    })
  })

  it('a join refused or unanswered fails the setup', async () => {
    const { ready } = joining()
    const settled = ready.then(() => 'joined', (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(15_001)
    await expect(settled).resolves.toMatch(/Failed to setup signaling/)
  })

  it('stays left once the call is left', async () => {
    const { svc, ready } = joining()
    const first = socket().joins(topic)[0]
    socket().reply(first)
    await ready
    await svc.leaveChannel()
    socket().closeChannel(first)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(socket().joins(topic)).toHaveLength(1)
  })
})

describe('DM call topic', () => {
  const CONV = '11111111-1111-1111-1111-111111111111'
  const topic = `realtime:dm-call:${CONV}`
  const tracks = () => socket().sent.filter((f) => f.topic === topic && f.event === 'presence' && f.payload?.event === 'track')

  it('is joined again after a server close, tracks this client again and delivers signals', async () => {
    const seen: unknown[] = []
    const off = dmCallSignaling.subscribeToConversation(CONV, (signal) => seen.push(signal.type))
    void dmCallSignaling.trackCallPresence(CONV, { callType: 'voice', isCaller: true, systemMessageId: null } as any)
    await vi.advanceTimersByTimeAsync(0)
    socket().open()
    await vi.advanceTimersByTimeAsync(0)
    const first = socket().joins(topic)[0]
    socket().reply(first)
    await vi.advanceTimersByTimeAsync(0)
    const tracked = tracks().length
    expect(tracked).toBeGreaterThan(0)

    socket().closeChannel(first)
    await vi.advanceTimersByTimeAsync(BACKOFF_MS)
    const second = socket().joins(topic)[1]
    expect(second).toBeDefined()
    socket().reply(second)
    await vi.advanceTimersByTimeAsync(0)
    expect(tracks().length).toBeGreaterThan(tracked)

    socket().deliver({
      topic, event: 'broadcast', ref: null, join_ref: second.ref,
      payload: { type: 'broadcast', event: 'call-signal', payload: { type: 'leave', callerId: 'them', callType: 'voice', timestamp: 1, conversationId: CONV } },
    })
    expect(seen).toEqual(['leave'])
    off()
  })

  it('a topic nothing needs any more is not joined again', async () => {
    const off = dmCallSignaling.subscribeToConversation(CONV, () => {})
    await vi.advanceTimersByTimeAsync(0)
    socket().open()
    await vi.advanceTimersByTimeAsync(0)
    const first = socket().joins(topic)[0]
    socket().reply(first)
    await vi.advanceTimersByTimeAsync(0)

    socket().closeChannel(first)
    off()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(socket().joins(topic)).toHaveLength(1)
  })

  it('a topic this client leaves is not joined again', async () => {
    const off = dmCallSignaling.subscribeToConversation(CONV, () => {})
    await vi.advanceTimersByTimeAsync(0)
    socket().open()
    await vi.advanceTimersByTimeAsync(0)
    socket().reply(socket().joins(topic)[0])
    await vi.advanceTimersByTimeAsync(0)
    off()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(socket().joins(topic)).toHaveLength(1)
  })

  describe('cleanup, at a session end', () => {
    const leaves = () => socket().sent.filter((f) => f.event === 'phx_leave' && f.topic === topic)
    const channels = () => (dmCallSignaling as any).channels as Map<string, RealtimeChannel>

    it('leaves a topic still joining: its late answer registers nothing', async () => {
      dmCallSignaling.subscribeToConversation(CONV, () => {})
      await vi.advanceTimersByTimeAsync(0)
      socket().open()
      await vi.advanceTimersByTimeAsync(0)
      const join = socket().joins(topic)[0]
      dmCallSignaling.cleanup()
      await vi.advanceTimersByTimeAsync(0)
      socket().reply(join)
      await vi.advanceTimersByTimeAsync(0)
      expect(leaves()).toHaveLength(1)
      expect(channels().size).toBe(0)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(socket().joins(topic)).toHaveLength(1)
    })

    it('a topic asked for and not yet opened is not opened', async () => {
      let answer!: (id: string) => void
      profile.read = () => new Promise((resolve) => { answer = resolve })
      dmCallSignaling.subscribeToConversation(CONV, () => {})
      dmCallSignaling.cleanup()
      answer('me')
      await vi.advanceTimersByTimeAsync(0)
      expect(FakeSocket.sockets.flatMap((s) => s.joins(topic))).toEqual([])
      expect(channels().size).toBe(0)
    })

    it('the next account\'s topic of the same conversation is its own, and survives the first one\'s end', async () => {
      const before: string[] = []
      dmCallSignaling.subscribeToConversation(CONV, (signal) => before.push(signal.type))
      await vi.advanceTimersByTimeAsync(0)
      socket().open()
      await vi.advanceTimersByTimeAsync(0)
      const first = socket().joins(topic)[0]
      dmCallSignaling.cleanup()

      const after: string[] = []
      const off = dmCallSignaling.subscribeToConversation(CONV, (signal) => after.push(signal.type))
      await vi.advanceTimersByTimeAsync(0)
      socket().reply(first)
      await vi.advanceTimersByTimeAsync(0)
      const second = socket().joins(topic).at(-1)!
      expect(second.ref).not.toBe(first.ref)
      socket().reply(second)
      await vi.advanceTimersByTimeAsync(0)
      expect(channels().size).toBe(1)

      socket().deliver({
        topic, event: 'broadcast', ref: null, join_ref: second.ref,
        payload: { type: 'broadcast', event: 'call-signal', payload: { type: 'leave', callerId: 'them', callType: 'voice', timestamp: 1, conversationId: CONV } },
      })
      expect(after).toEqual(['leave'])
      expect(before).toEqual([])
      off()
    })
  })
})
