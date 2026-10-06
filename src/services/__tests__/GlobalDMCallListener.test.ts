import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// Receiving side of a DM call. A muted caller or conversation rings without
// ringtone or popup, but the call is recorded and its conversation followed so
// the conversation list shows it while it is live. Refusals are declined and
// never recorded. A server voice channel does not keep a federated ring out.
// An answer that crosses the ring's end leaves the room as "Call ended". On
// the caller, an unanswered ring leaves the room as "No answer".

const rt = vi.hoisted(() => {
  const channels: any[] = []
  const make = (topic: string, opts: unknown) => {
    const handlers: Record<string, (payload: any) => void> = {}
    const channel: any = {
      topic,
      opts,
      handlers,
      sent: [] as any[],
      on: vi.fn((type: string, filter: { event: string }, cb: (payload: any) => void) => {
        handlers[`${type}:${filter.event}`] = cb
        return channel
      }),
      subscribe: vi.fn((cb?: (status: string) => void) => { cb?.('SUBSCRIBED'); return channel }),
      send: vi.fn(async (msg: any) => { channel.sent.push(msg); return 'ok' }),
      track: vi.fn(async () => 'ok'),
      untrack: vi.fn(async () => 'ok'),
      unsubscribe: vi.fn(async () => 'ok'),
      presenceState: vi.fn(() => ({})),
    }
    channels.push(channel)
    return channel
  }
  return { channels, make, rpc: vi.fn(async () => ({ data: null, error: null })) }
})

vi.mock('@/supabase', () => ({
  supabase: {
    channel: (topic: string, opts: unknown) => rt.make(topic, opts),
    rpc: rt.rpc,
    auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
  },
}))

const permissions = vi.hoisted(() => ({ canReceiveCall: vi.fn() }))
vi.mock('@/services/DMCallPermissions', () => ({
  dmCallPermissions: {
    canReceiveCall: permissions.canReceiveCall,
    getDeclineReasonMessage: () => 'Call declined',
  },
}))

const userEvents = vi.hoisted(() => ({ handlers: {} as Record<string, (payload: any) => void> }))
vi.mock('@/services/UserEventChannel', () => ({
  userEventChannel: {
    connect: vi.fn(),
    on: vi.fn((type: string, handler: (payload: any) => void) => {
      userEvents.handlers[type] = handler
      return () => {}
    }),
  },
}))

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentProfileId: async () => 'me' },
}))
vi.mock('@/services/userDataService', () => ({
  userDataService: { ensureUsersLoaded: async () => {}, getUser: () => ({ displayName: 'Caller' }) },
}))
vi.mock('@/utils/avatarUtils', () => ({ getAvatarUrl: (path: string) => path }))
vi.mock('@/stores/unifiedVoiceChannel', async () => {
  const { reactive } = await import('vue')
  const store: any = reactive({
    isConnected: true,
    effectiveChannelId: 'server-voice' as string | null,
    effectiveServerId: 'server-1',
    leaveVoiceChannel: vi.fn(async () => {
      store.effectiveChannelId = null
      return true
    }),
  })
  return { useUnifiedVoiceChannelStore: () => store }
})

import { globalDMCallListener } from '@/services/GlobalDMCallListener'
import { dmCallSignaling } from '@/services/DMCallSignaling'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'

const voice = () => useUnifiedVoiceChannelStore() as any

const CONV = '11111111-1111-1111-1111-111111111111'
const OTHER_CONV = '22222222-2222-2222-2222-222222222222'

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

const ringTopic = () => rt.channels.find((c) => c.topic === 'dm-calls:me')
const conversationTopic = (id: string) => rt.channels.filter((c) => c.topic === `dm-call:${id}`)

const signal = (type: string, conversationId = CONV) => {
  ringTopic().handlers['broadcast:incoming-call']({
    payload: { type, callerId: 'caller', callType: 'voice', timestamp: Date.now(), conversationId },
  })
}

// Showing the modal schedules a DOM probe 100 ms later; it must run before teardown.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 150)))

beforeEach(async () => {
  globalDMCallListener.dismissIncomingCall()
  globalDMCallListener.cleanup()
  dmCallSignaling.cleanup()
  rt.channels.length = 0
  rt.rpc.mockClear()
  permissions.canReceiveCall.mockReset()
  Object.values(toast).forEach((fn) => fn.mockClear())
  voice().effectiveChannelId = 'server-voice'
  voice().leaveVoiceChannel.mockClear()
  await globalDMCallListener.initialize('auth-me')
})

describe('muted ring', () => {
  beforeEach(() => {
    permissions.canReceiveCall.mockResolvedValue({ allowed: true, silent: true })
  })

  it('shows no popup and plays no ringtone, but records and follows the call', async () => {
    signal('initiate')
    await settle()

    expect(globalDMCallListener.showIncomingCallModal.value).toBe(false)
    expect(globalDMCallListener.incomingCall.value).toBeNull()
    expect(dmCallSignaling.getActiveCall(CONV)).toMatchObject({ callerId: 'caller', ringing: true })
    expect(conversationTopic(CONV)).toHaveLength(1)
  })

  it('clears on timeout without a missed-call toast and releases the conversation channel', async () => {
    signal('initiate')
    await settle()
    signal('timeout')
    await settle()

    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(false)
    expect(toast.info).not.toHaveBeenCalledWith('Missed call')
    expect(conversationTopic(CONV)[0].unsubscribe).toHaveBeenCalled()
  })

  it('clears when the caller cancels', async () => {
    signal('initiate')
    await settle()
    signal('end')
    await settle()
    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(false)
  })

  it('leaves another conversation\'s popup ringing when it ends', async () => {
    permissions.canReceiveCall.mockResolvedValueOnce({ allowed: true })
    signal('initiate', OTHER_CONV)
    await settle()
    signal('initiate')
    await settle()
    signal('end')
    await settle()

    expect(globalDMCallListener.showIncomingCallModal.value).toBe(true)
    expect(globalDMCallListener.incomingCall.value?.conversationId).toBe(OTHER_CONV)
  })
})

describe('unmuted ring', () => {
  it('shows the incoming-call popup and toasts a missed call on timeout', async () => {
    permissions.canReceiveCall.mockResolvedValue({ allowed: true })
    signal('initiate')
    await settle()
    expect(globalDMCallListener.showIncomingCallModal.value).toBe(true)
    expect(globalDMCallListener.incomingCall.value?.conversationId).toBe(CONV)

    signal('timeout')
    await settle()
    expect(globalDMCallListener.showIncomingCallModal.value).toBe(false)
    expect(toast.info).toHaveBeenCalledWith('Missed call')
    expect(toast.info).not.toHaveBeenCalledWith('No answer')
    expect(voice().leaveVoiceChannel).not.toHaveBeenCalled()
  })

  it('a refused ring is declined with its reason and never recorded', async () => {
    permissions.canReceiveCall.mockResolvedValue({ allowed: false, reason: 'busy' })
    signal('initiate')
    await settle()

    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(false)
    expect(globalDMCallListener.showIncomingCallModal.value).toBe(false)
    const sent = conversationTopic(CONV).flatMap((c) => c.sent)
    expect(sent).toEqual([expect.objectContaining({ payload: expect.objectContaining({ type: 'busy', callerId: 'me' }) })])
  })

  it('a ring cancelled while the gate runs is not recorded', async () => {
    let allow!: (value: unknown) => void
    permissions.canReceiveCall.mockReturnValue(new Promise((resolve) => { allow = resolve }))
    signal('initiate')
    await settle()
    signal('end')
    await settle()
    allow({ allowed: true })
    await settle()

    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(false)
    expect(globalDMCallListener.showIncomingCallModal.value).toBe(false)
  })
})

describe('an answer crossing the end of the ring', () => {
  beforeEach(async () => {
    permissions.canReceiveCall.mockResolvedValue({ allowed: true })
    signal('initiate')
    await settle()
    await dmCallSignaling.acceptCall(CONV, 'me')
  })

  it('leaves the room it is joining with "Call ended", not "Missed call"', async () => {
    voice().effectiveChannelId = `dm-${CONV}`
    signal('timeout')
    await settle()

    expect(voice().leaveVoiceChannel).toHaveBeenCalledTimes(1)
    expect(toast.info).toHaveBeenCalledWith('Call ended')
    expect(toast.info).not.toHaveBeenCalledWith('Missed call')
  })

  it('leaves once a join that had not started reaches the room', async () => {
    signal('end')
    await settle()
    expect(voice().leaveVoiceChannel).not.toHaveBeenCalled()

    voice().effectiveChannelId = `dm-${CONV}`
    await settle()
    expect(voice().leaveVoiceChannel).toHaveBeenCalledTimes(1)
    expect(toast.info).toHaveBeenCalledWith('Call ended')
  })

  it('a new ring in the conversation cancels the wait', async () => {
    signal('timeout')
    await settle()
    signal('initiate')
    await settle()

    voice().effectiveChannelId = `dm-${CONV}`
    await settle()
    expect(voice().leaveVoiceChannel).not.toHaveBeenCalled()
  })
})

describe('own ring timeout', () => {
  it('leaves the call\'s room and says "No answer"', async () => {
    vi.useFakeTimers()
    try {
      await dmCallSignaling.initiateCall(CONV, 'me', 'voice', ['them'])
      voice().effectiveChannelId = `dm-${CONV}`
      await vi.advanceTimersByTimeAsync(30000)
      await vi.advanceTimersByTimeAsync(0)

      expect(dmCallSignaling.hasActiveCall(CONV)).toBe(false)
      expect(voice().leaveVoiceChannel).toHaveBeenCalledTimes(1)
      expect(toast.info).toHaveBeenCalledWith('No answer')
    } finally {
      vi.useRealTimers()
    }
  })

  it('says "No answer" without leaving another room', async () => {
    vi.useFakeTimers()
    try {
      await dmCallSignaling.initiateCall(CONV, 'me', 'voice', ['them'])
      await vi.advanceTimersByTimeAsync(30000)
      await vi.advanceTimersByTimeAsync(0)

      expect(voice().leaveVoiceChannel).not.toHaveBeenCalled()
      expect(toast.info).toHaveBeenCalledWith('No answer')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('federated ring', () => {
  const federatedRing = () => userEvents.handlers['federated_call:incoming']({
    callId: 'call-1',
    callerId: 'remote-caller',
    callerName: 'Remote',
    callerAvatar: '',
    callerFederatedId: 'https://remote.test/users/a',
    callType: 'voice',
    conversationId: CONV,
    livekitUrl: 'wss://livekit.remote.test',
    roomName: `federated-dm-${OTHER_CONV}-1700000000000`,
  })

  it('rings a callee who is in a server voice channel', async () => {
    permissions.canReceiveCall.mockResolvedValue({ allowed: true })
    federatedRing()
    await settle()
    expect(globalDMCallListener.showIncomingCallModal.value).toBe(true)
  })

  it('a muted ring is recorded without a popup', async () => {
    permissions.canReceiveCall.mockResolvedValue({ allowed: true, silent: true })
    federatedRing()
    await settle()
    expect(globalDMCallListener.showIncomingCallModal.value).toBe(false)
    expect(dmCallSignaling.getActiveCall(CONV)).toMatchObject({ isFederated: true, ringing: true })
  })
})
