import { describe, it, expect, vi, beforeEach } from 'vitest'

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
