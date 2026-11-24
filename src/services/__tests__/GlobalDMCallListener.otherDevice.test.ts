import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// One account signed in on two devices, both rung. This client is the device that did not
// answer: the other device's accept, join, decline or busy, which send_signal also puts on the
// account's own dm-calls:{profile} with the sender it names, stops the ring here. The caller's later
// timeout is then no missed call. A broadcast or presence entry on dm-call:{conversation} that
// names this account stops nothing: a participant could forge either.

const rt = vi.hoisted(() => {
  const channels: any[] = []
  const make = (topic: string, opts: unknown) => {
    const handlers: Record<string, (payload: any) => void> = {}
    const channel: any = {
      topic,
      opts,
      handlers,
      presence: {} as Record<string, any[]>,
      on: vi.fn((type: string, filter: { event: string }, cb: (payload: any) => void) => {
        handlers[`${type}:${filter.event}`] = cb
        return channel
      }),
      subscribe: vi.fn((cb?: (status: string) => void) => { cb?.('SUBSCRIBED'); return channel }),
      send: vi.fn(async () => 'ok'),
      track: vi.fn(async () => 'ok'),
      untrack: vi.fn(async () => 'ok'),
      unsubscribe: vi.fn(async () => 'ok'),
      presenceState: vi.fn(() => channel.presence),
    }
    channels.push(channel)
    return channel
  }
  return { channels, make, rpc: vi.fn(async () => ({ data: null, error: null })) }
})

vi.mock('@/supabase', () => ({
  supabase: {
    channel: (topic: string, opts: unknown) => rt.make(topic, opts),
    removeChannel: vi.fn(async () => 'ok'),
    rpc: rt.rpc,
    auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
  },
}))
const gate = vi.hoisted(() => ({ canReceiveCall: vi.fn() }))
vi.mock('@/services/DMCallPermissions', () => ({
  dmCallPermissions: {
    canReceiveCall: gate.canReceiveCall,
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
vi.mock('@/services/AuthContextService', () => ({ authContextService: { getCurrentProfileId: async () => 'me' } }))
const users = vi.hoisted(() => ({ ensureUsersLoaded: vi.fn() }))
vi.mock('@/services/userDataService', () => ({
  userDataService: { ensureUsersLoaded: users.ensureUsersLoaded, getUser: () => ({ displayName: 'Caller' }) },
}))
vi.mock('@/utils/avatarUtils', () => ({ getAvatarUrl: (path: string) => path }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({
  useUnifiedVoiceChannelStore: () => ({ effectiveChannelId: null, leaveVoiceChannel: vi.fn(async () => true) }),
}))

import { globalDMCallListener } from '@/services/GlobalDMCallListener'
import { dmCallSignaling } from '@/services/DMCallSignaling'

const CONV = '11111111-1111-1111-1111-111111111111'
const OTHER_CONV = '22222222-2222-2222-2222-222222222222'

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

const ring = (type: string, conversationId = CONV) => {
  rt.channels.find((c) => c.topic === 'dm-calls:me').handlers['broadcast:incoming-call']({
    payload: { type, callerId: 'caller', callType: 'voice', timestamp: Date.now(), conversationId },
  })
}
const conversationTopic = (id = CONV) => rt.channels.filter((c) => c.topic === `dm-call:${id}`).at(-1)
/** A call-signal send_signal relayed to this account's own ring topic. */
const callSignal = (type: string, callerId: string, conversationId = CONV) => {
  rt.channels.find((c) => c.topic === 'dm-calls:me').handlers['broadcast:call-signal']({
    payload: { type, callerId, callType: 'voice', timestamp: Date.now(), conversationId },
  })
}
const ringing = () => globalDMCallListener.showIncomingCallModal.value

afterAll(() => new Promise((resolve) => setTimeout(resolve, 150)))

/** A promise held until `release` is called. */
function held<T>(value: T) {
  let release!: () => void
  const promise = new Promise<T>((resolve) => { release = () => resolve(value) })
  return { promise, release }
}

beforeEach(async () => {
  gate.canReceiveCall.mockReset().mockResolvedValue({ allowed: true })
  users.ensureUsersLoaded.mockReset().mockResolvedValue(undefined)
  globalDMCallListener.dismissIncomingCall()
  globalDMCallListener.cleanup()
  dmCallSignaling.cleanup()
  rt.channels.length = 0
  Object.values(toast).forEach((fn) => fn.mockClear())
  await globalDMCallListener.initialize('auth-me')
  ring('initiate')
  await settle()
  expect(ringing()).toBe(true)
})

describe('a ring answered on another device of the account', () => {
  it.each(['accept', 'join', 'decline', 'busy'])('stops ringing here on the other device\'s %s', async (type) => {
    callSignal(type, 'me')
    expect(ringing()).toBe(false)
    expect(globalDMCallListener.incomingCall.value).toBeNull()
  })

  it('keeps ringing on another participant\'s answer', () => {
    callSignal('accept', 'someone-else')
    expect(ringing()).toBe(true)
  })

  it('a presence entry under this account\'s key stops nothing', () => {
    const topic = conversationTopic()
    topic.presence = { me: [{ isCaller: false, joinedAt: new Date().toISOString() }] }
    topic.handlers['presence:sync']({})
    expect(ringing()).toBe(true)
  })

  it('a conversation-topic broadcast naming this account stops nothing', () => {
    conversationTopic().handlers['broadcast:call-signal']({
      payload: { type: 'accept', callerId: 'me', callType: 'voice', timestamp: Date.now(), conversationId: CONV },
    })
    expect(ringing()).toBe(true)
  })

  it('a decline elsewhere makes the caller\'s timeout no missed call', async () => {
    callSignal('decline', 'me')
    ring('timeout')
    await settle()
    expect(toast.info).not.toHaveBeenCalledWith('Missed call')
  })

  it('a ring no device answered is still a missed call', async () => {
    ring('timeout')
    await settle()
    expect(toast.info).toHaveBeenCalledWith('Missed call')
  })

  it('leaves the ring of another conversation alone', async () => {
    ring('initiate', OTHER_CONV)
    await settle()
    expect(globalDMCallListener.incomingCall.value?.conversationId).toBe(OTHER_CONV)
    callSignal('accept', 'me', CONV)
    expect(ringing()).toBe(true)
  })
})

describe('a ring answered elsewhere before it shows here', () => {
  it('while the permission gate runs', async () => {
    const check = held({ allowed: true })
    gate.canReceiveCall.mockReturnValue(check.promise)
    ring('initiate', OTHER_CONV)
    await settle()
    callSignal('accept', 'me', OTHER_CONV)
    check.release()
    await settle()
    expect(globalDMCallListener.incomingCall.value?.conversationId).toBe(CONV)
  })

  it('while the caller\'s data loads', async () => {
    const load = held(undefined)
    users.ensureUsersLoaded.mockReturnValue(load.promise)
    ring('initiate', OTHER_CONV)
    await settle()
    callSignal('accept', 'me', OTHER_CONV)
    load.release()
    await settle()
    expect(globalDMCallListener.incomingCall.value?.conversationId).toBe(CONV)

    ring('timeout', OTHER_CONV)
    await settle()
    expect(toast.info).not.toHaveBeenCalledWith('Missed call')
  })
})

describe('a ring this client declined', () => {
  it('ends with no missed call', async () => {
    globalDMCallListener.markRingDeclined(CONV)
    globalDMCallListener.dismissIncomingCall()
    ring('timeout')
    await settle()
    expect(toast.info).not.toHaveBeenCalledWith('Missed call')
  })
})

describe('a federated ring answered on another device of the account', () => {
  const FED_CONV = '33333333-3333-3333-3333-333333333333'
  const federatedRing = async () => {
    userEvents.handlers['federated_call:incoming']({
      callId: 'call-1', callerId: 'remote', callerName: 'Remote', callerAvatar: '', callerFederatedId: 'https://remote.test/users/r',
      callType: 'voice', conversationId: FED_CONV, livekitUrl: 'wss://lk.remote.test', roomName: `federated-dm-${FED_CONV}-1`,
    })
    await settle()
  }

  it('stops ringing here when the backend says another device answered', async () => {
    globalDMCallListener.dismissIncomingCall()
    await federatedRing()
    expect(globalDMCallListener.incomingCall.value?.conversationId).toBe(FED_CONV)
    userEvents.handlers['federated_call:answered']({ conversationId: FED_CONV, callId: 'call-1', outcome: 'accepted' })
    expect(ringing()).toBe(false)
  })

  it('never shows when another device answered while the permission gate ran', async () => {
    const check = held({ allowed: true })
    gate.canReceiveCall.mockReturnValue(check.promise)
    await federatedRing()
    userEvents.handlers['federated_call:answered']({ conversationId: FED_CONV, callId: 'call-1', outcome: 'accepted' })
    check.release()
    await settle()
    expect(globalDMCallListener.incomingCall.value?.conversationId).toBe(CONV)
    expect(dmCallSignaling.hasActiveCall(FED_CONV)).toBe(false)
  })

  it('leaves another conversation\'s ring alone', async () => {
    userEvents.handlers['federated_call:answered']({ conversationId: FED_CONV, callId: 'call-1', outcome: 'rejected' })
    expect(globalDMCallListener.incomingCall.value?.conversationId).toBe(CONV)
  })
})
