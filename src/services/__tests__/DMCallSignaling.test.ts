import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Call signalling over private Realtime channels: the conversation topic is
// private, rings go through ring_dm_call, and federated calls take their token
// from the accept response.

const realtime = vi.hoisted(() => {
  const opened: Array<{ topic: string; opts: any; channel: any }> = []
  const make = (topic: string, opts: any) => {
    const channel: any = {
      topic,
      sent: [] as any[],
      on: vi.fn(() => channel),
      subscribe: vi.fn((cb: (status: string) => void) => { cb('SUBSCRIBED'); return channel }),
      send: vi.fn(async (msg: any) => { channel.sent.push(msg); return 'ok' }),
      track: vi.fn(async () => 'ok'),
      untrack: vi.fn(async () => 'ok'),
      unsubscribe: vi.fn(async () => 'ok'),
      presenceState: vi.fn(() => ({})),
    }
    opened.push({ topic, opts, channel })
    return channel
  }
  return { opened, make, rpc: vi.fn(async () => ({ data: 1, error: null })) }
})

vi.mock('@/supabase', () => ({
  supabase: {
    channel: (topic: string, opts: any) => realtime.make(topic, opts),
    rpc: realtime.rpc,
    auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
  },
}))
vi.mock('@/services/instanceConfig', () => ({ apiUrl: (p: string) => p }))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentProfileId: async () => 'me' },
}))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { dmCallSignaling } from '@/services/DMCallSignaling'

const CONV = '11111111-1111-1111-1111-111111111111'
const CALLER_CONV = '22222222-2222-2222-2222-222222222222'
const ROOM = `federated-dm-${CALLER_CONV}-1700000000000`
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  dmCallSignaling.cleanup()
  realtime.opened.length = 0
  realtime.rpc.mockClear()
  vi.unstubAllGlobals()
})

describe('local calls', () => {
  it('opens the conversation topic as a private channel', async () => {
    const off = dmCallSignaling.subscribeToConversation(CONV, () => {})
    await flush()
    expect(realtime.opened).toEqual([
      expect.objectContaining({ topic: `dm-call:${CONV}`, opts: { config: expect.objectContaining({ private: true }) } }),
    ])
    off()
  })

  it('rings through ring_dm_call, never on another user\'s topic', async () => {
    await dmCallSignaling.initiateCall(CONV, 'me', 'video', ['them'])
    expect(realtime.rpc).toHaveBeenCalledWith('ring_dm_call', {
      p_conversation_id: CONV, p_receiver_ids: ['them'], p_signal: 'initiate', p_call_type: 'video', p_system_message_id: 1,
    })
    expect(realtime.opened.map((o) => o.topic)).toEqual([])

    await dmCallSignaling.leaveCall(CONV, 'me')
    expect(realtime.rpc).toHaveBeenLastCalledWith('ring_dm_call', expect.objectContaining({ p_signal: 'end', p_receiver_ids: ['them'] }))
    expect(realtime.opened.every((o) => o.topic === `dm-call:${CONV}` && o.opts.config.private === true)).toBe(true)
  })

  it('a signal without a subscription opens the private topic and releases it', async () => {
    await dmCallSignaling.sendSignal(CONV, { type: 'decline', callerId: 'me', callType: 'voice', timestamp: 1, conversationId: CONV })
    expect(realtime.opened).toHaveLength(1)
    const { topic, opts, channel } = realtime.opened[0]
    expect(topic).toBe(`dm-call:${CONV}`)
    expect(opts.config.private).toBe(true)
    expect(channel.sent[0]).toMatchObject({ type: 'broadcast', event: 'call-signal', payload: { type: 'decline' } })
    expect(channel.unsubscribe).toHaveBeenCalled()
  })
})

describe('caller ring timeout', () => {
  const broadcast = (channel: any) => channel.on.mock.calls.find((c: any[]) => c[0] === 'broadcast')[2] as (p: any) => void
  const answer = (type: 'accept' | 'join') => ({ payload: { type, callerId: 'them', callType: 'voice', timestamp: 1, conversationId: CONV } })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('an unanswered ring ends on the caller: the call goes, timeout handlers run, receivers get the timeout ring', async () => {
    vi.useFakeTimers()
    const expired: string[] = []
    const off = dmCallSignaling.onRingTimeout((id) => expired.push(id))
    await dmCallSignaling.initiateCall(CONV, 'me', 'voice', ['them'])

    await vi.advanceTimersByTimeAsync(30000)
    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(false)
    expect(expired).toEqual([CONV])
    expect(realtime.rpc).toHaveBeenLastCalledWith('ring_dm_call', expect.objectContaining({ p_signal: 'timeout', p_receiver_ids: ['them'] }))
    off()
  })

  it('an answer broadcast stops the ring with no listener mounted', async () => {
    vi.useFakeTimers()
    const expired: string[] = []
    const off = dmCallSignaling.onRingTimeout((id) => expired.push(id))
    await dmCallSignaling.initiateCall(CONV, 'me', 'voice', ['them'])
    await dmCallSignaling.trackCallPresence(CONV, { callType: 'voice', isCaller: true, systemMessageId: null })
    broadcast(realtime.opened[0].channel)(answer('accept'))

    await vi.advanceTimersByTimeAsync(30000)
    expect(expired).toEqual([])
    expect(dmCallSignaling.getActiveCall(CONV)).toMatchObject({ ringing: false, participants: ['me', 'them'] })
    off()
  })

  it('an answer that lands after the timeout finds no call', async () => {
    vi.useFakeTimers()
    await dmCallSignaling.initiateCall(CONV, 'me', 'voice', ['them'])
    await vi.advanceTimersByTimeAsync(30000)
    await expect(dmCallSignaling.acceptCall(CONV, 'them')).resolves.toBe(false)
    await expect(dmCallSignaling.joinCall(CONV, 'them')).resolves.toBe(false)
  })
})

describe('rung calls', () => {
  const presenceSync = (channel: any) => channel.on.mock.calls.find((c: any[]) => c[0] === 'presence')[2] as () => void
  const meta = (isCaller: boolean) => [{ callType: 'voice', joinedAt: new Date().toISOString(), isCaller, systemMessageId: null }]

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a followed call holds the conversation channel until it ends', async () => {
    dmCallSignaling.registerRemoteCall(CONV, 'caller', 'voice')
    dmCallSignaling.followCall(CONV)
    await flush()
    expect(realtime.opened.map((o) => o.topic)).toEqual([`dm-call:${CONV}`])
    const { channel } = realtime.opened[0]
    expect(channel.unsubscribe).not.toHaveBeenCalled()

    dmCallSignaling.handleRemoteSignal({ type: 'end', callerId: 'caller', callType: 'voice', timestamp: 1, conversationId: CONV })
    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(false)
    expect(channel.unsubscribe).toHaveBeenCalled()
  })

  it('a ring whose present caller vanishes expires with the watchdog', async () => {
    vi.useFakeTimers()
    dmCallSignaling.registerRemoteCall(CONV, 'caller', 'voice')
    dmCallSignaling.followCall(CONV)
    await vi.advanceTimersByTimeAsync(0)
    const { channel } = realtime.opened[0]

    channel.presenceState.mockReturnValue({ caller: meta(true) })
    presenceSync(channel)()
    channel.presenceState.mockReturnValue({})
    presenceSync(channel)()
    expect(dmCallSignaling.getActiveCall(CONV)?.ringing).toBe(true)

    await vi.advanceTimersByTimeAsync(45000)
    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(false)
    expect(channel.unsubscribe).toHaveBeenCalled()
  })

  it('a followed group call answered by another member stays live until presence empties', async () => {
    vi.useFakeTimers()
    dmCallSignaling.registerRemoteCall(CONV, 'caller', 'voice')
    dmCallSignaling.followCall(CONV)
    await vi.advanceTimersByTimeAsync(0)
    const { channel } = realtime.opened[0]

    channel.presenceState.mockReturnValue({ caller: meta(true), member: meta(false) })
    presenceSync(channel)()
    expect(dmCallSignaling.getActiveCall(CONV)).toMatchObject({ ringing: false, participants: ['caller', 'member'] })

    await vi.advanceTimersByTimeAsync(60000)
    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(true)

    channel.presenceState.mockReturnValue({})
    presenceSync(channel)()
    await vi.advanceTimersByTimeAsync(5000)
    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(false)
  })
})

describe('federated calls', () => {
  const ring = () => {
    dmCallSignaling.registerRemoteCall(CONV, 'caller-mirror', 'voice')
    Object.assign(dmCallSignaling.getActiveCall(CONV)!, { isFederated: true, roomName: ROOM, callerFederatedId: 'https://remote.test/users/a' })
  }

  it('accept answers with the token the caller\'s instance issued', async () => {
    ring()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true, token: 'T', livekitUrl: 'wss://livekit.remote.test', roomName: ROOM,
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(dmCallSignaling.acceptFederatedCall(CONV, 'me', 'https://remote.test/users/a'))
      .resolves.toEqual({ token: 'T', wsUrl: 'wss://livekit.remote.test', roomName: ROOM })
    expect(dmCallSignaling.getActiveCall(CONV)?.ringing).toBe(false)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/livekit/federated-call/accept')
  })

  it('accept without a token leaves the call ringing', async () => {
    ring()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no token' }), { status: 502 })))
    await expect(dmCallSignaling.acceptFederatedCall(CONV, 'me', 'https://remote.test/users/a')).resolves.toBeNull()
    expect(dmCallSignaling.getActiveCall(CONV)?.ringing).toBe(true)
  })

  it('maps the caller\'s room back to this instance\'s conversation', () => {
    ring()
    expect(dmCallSignaling.conversationForRoom(ROOM)).toBe(CONV)
    dmCallSignaling.cleanup()
    expect(dmCallSignaling.conversationForRoom(ROOM)).toBe(CALLER_CONV)
  })

  it('remote accepted and ended reach listeners as accept and end', async () => {
    ring()
    const seen: string[] = []
    const off = dmCallSignaling.subscribeToConversation(CONV, (s) => seen.push(`${s.type}:${s.callerId}`))
    dmCallSignaling.handleFederatedCallEvent('accepted', { conversationId: CONV, roomName: ROOM, partyId: 'peer' })
    expect(dmCallSignaling.getActiveCall(CONV)?.ringing).toBe(false)
    dmCallSignaling.handleFederatedCallEvent('ended', { conversationId: CONV, roomName: `federated-dm-${CALLER_CONV}-1` })
    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(true)
    dmCallSignaling.handleFederatedCallEvent('ended', { conversationId: CONV, roomName: ROOM, partyId: 'peer' })
    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(false)
    expect(seen).toEqual(['accept:peer', 'end:peer'])
    off()
  })

  it('end goes to the backend even after local state is gone', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await dmCallSignaling.endFederatedCall(CONV, 'me')
    expect(fetchMock).toHaveBeenCalledWith('/api/livekit/federated-call/end', expect.objectContaining({
      body: JSON.stringify({ conversationId: CONV }),
    }))
  })
})

describe('join liveness', () => {
  const presenceSync = (channel: any) => channel.on.mock.calls.find((c: any[]) => c[0] === 'presence')[2] as () => void
  const meta = (isCaller: boolean, systemMessageId: string | null = null) =>
    [{ callType: 'voice', joinedAt: new Date().toISOString(), isCaller, systemMessageId }]
  const answered = () => {
    dmCallSignaling.registerRemoteCall(CONV, 'caller', 'voice', 'msg-1')
    dmCallSignaling.handleRemoteSignal({ type: 'join', callerId: 'them', callType: 'voice', timestamp: 1, conversationId: CONV })
  }
  const finalized = () => realtime.rpc.mock.calls.filter((c: any[]) => c[0] === 'finalize_dm_call_message')

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a ringing or federated call is live without opening its channel', async () => {
    dmCallSignaling.registerRemoteCall(CONV, 'caller', 'voice')
    await expect(dmCallSignaling.isCallLive(CONV)).resolves.toBe(true)
    Object.assign(dmCallSignaling.getActiveCall(CONV)!, { ringing: false, isFederated: true })
    await expect(dmCallSignaling.isCallLive(CONV)).resolves.toBe(true)
    expect(realtime.opened).toEqual([])
  })

  it('with no tracked call, one presence check on the call topic finds a live call and follows it', async () => {
    const live = dmCallSignaling.isCallLive(CONV)
    await flush()
    expect(realtime.opened.map((o) => o.topic)).toEqual([`dm-call:${CONV}`])
    const { channel } = realtime.opened[0]

    channel.presenceState.mockReturnValue({ them: meta(true, 'msg-1') })
    presenceSync(channel)()
    await expect(live).resolves.toBe(true)
    expect(dmCallSignaling.getActiveCall(CONV)).toMatchObject({ ringing: false, participants: ['them'], systemMessageId: 'msg-1' })
    expect(channel.unsubscribe).not.toHaveBeenCalled()

    dmCallSignaling.handleRemoteSignal({ type: 'end', callerId: 'them', callType: 'voice', timestamp: 1, conversationId: CONV })
    expect(channel.unsubscribe).toHaveBeenCalled()
  })

  it('with no tracked call and nobody present the call is not live and the channel closes', async () => {
    const live = dmCallSignaling.isCallLive(CONV)
    await flush()
    const { channel } = realtime.opened[0]
    presenceSync(channel)()
    await expect(live).resolves.toBe(false)
    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(false)
    expect(channel.unsubscribe).toHaveBeenCalled()
  })

  it('a stale tracked call nobody is present in ends on the check, without a channel left open', async () => {
    answered()
    expect(dmCallSignaling.getActiveCall(CONV)?.ringing).toBe(false)

    const live = dmCallSignaling.isCallLive(CONV)
    await flush()
    const { channel } = realtime.opened[0]
    presenceSync(channel)()
    await expect(live).resolves.toBe(false)
    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(false)
    expect(finalized()).toHaveLength(1)
    expect(channel.unsubscribe).toHaveBeenCalled()
  })

  it('a synced channel is read at once: a call emptied during its grace ends on the check', async () => {
    vi.useFakeTimers()
    const off = dmCallSignaling.subscribeToConversation(CONV, () => {})
    await vi.advanceTimersByTimeAsync(0)
    const { channel } = realtime.opened[0]
    channel.presenceState.mockReturnValue({ them: meta(true, 'msg-1') })
    presenceSync(channel)()
    channel.presenceState.mockReturnValue({})
    presenceSync(channel)()
    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(true)

    // Timers stay frozen: a check that waited for a sync would never resolve.
    await expect(dmCallSignaling.isCallLive(CONV)).resolves.toBe(false)
    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(false)

    await vi.advanceTimersByTimeAsync(5000)
    expect(finalized()).toHaveLength(1)
    expect(channel.unsubscribe).not.toHaveBeenCalled()
    off()
  })

  it('no presence sync within the check window leaves the decision to tracked state', async () => {
    vi.useFakeTimers()
    answered()
    const live = dmCallSignaling.isCallLive(CONV)
    await vi.advanceTimersByTimeAsync(3000)
    await expect(live).resolves.toBe(true)
    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(true)
    expect(realtime.opened[0].channel.unsubscribe).toHaveBeenCalled()

    dmCallSignaling.cleanup()
    const none = dmCallSignaling.isCallLive(CONV)
    await vi.advanceTimersByTimeAsync(3000)
    await expect(none).resolves.toBe(false)
  })
})
