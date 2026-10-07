/**
 * DMHeader.vue as the caller. The outgoing jingle plays only for a ring nobody
 * refused: not after a caller-side refusal, and not after a decline or busy
 * answer that lands while the caller's own join is in flight. A busy answer
 * ends a direct call. A refused call never asks to switch calls or leaves the
 * caller's current channel. As a receiver, a caller's ring timeout shows
 * nothing. Join does not join a call nobody is present in any more.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'

const rt = vi.hoisted(() => {
  const channels: any[] = []
  const make = (topic: string) => {
    const handlers: Record<string, (payload: any) => void> = {}
    const channel: any = {
      topic,
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
  const query: any = {}
  for (const m of ['select', 'eq', 'is', 'in', 'upsert', 'update', 'insert']) query[m] = () => query
  query.maybeSingle = async () => ({ data: null, error: null })
  query.single = async () => ({ data: null, error: null })
  const rpcResult = async (name: string) => ({ data: name === 'start_dm_call_message' ? 'msg-1' : 1, error: null })
  return { channels, make, query, rpcResult, rpc: vi.fn(rpcResult) }
})

vi.mock('@/supabase', () => ({
  supabase: {
    channel: (topic: string) => rt.make(topic),
    rpc: rt.rpc,
    from: () => rt.query,
  },
}))

const permissions = vi.hoisted(() => ({ canPlaceCall: vi.fn() }))
vi.mock('@/services/DMCallPermissions', () => ({
  dmCallPermissions: {
    canPlaceCall: permissions.canPlaceCall,
    getDeclineReasonMessage: () => 'Call declined',
  },
}))

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const playAudio = vi.hoisted(() => vi.fn())
vi.mock('@/stores/useTheme', () => ({ useThemeStore: () => ({ playAudio }) }))

const join = vi.hoisted(() => ({ release: null as null | (() => void), aborted: false }))
vi.mock('@/stores/unifiedVoiceChannel', async () => {
  const { reactive } = await import('vue')
  const { dmCallSignaling } = await import('@/services/DMCallSignaling')
  const store: any = reactive({
    isConnected: false,
    isConnecting: false,
    optimisticChannelId: null as string | null,
    currentChannelId: null as string | null,
    isOverlayVisible: false,
    joinError: null,
    localState: { isVideoEnabled: false },
    get isConnectedOrJoining() { return this.isConnected || this.optimisticChannelId !== null },
    get effectiveChannelId() { return this.currentChannelId || this.optimisticChannelId },
    toggleVideo: vi.fn(async () => {}),
    // Mirrors the store: a join can be cancelled by leaving while it is in flight.
    joinVoiceChannel: vi.fn(async (channelId: string) => {
      join.aborted = false
      store.optimisticChannelId = channelId
      store.isConnecting = true
      await new Promise<void>((resolve) => { join.release = resolve })
      store.isConnecting = false
      store.optimisticChannelId = null
      if (join.aborted) return false
      store.isConnected = true
      store.currentChannelId = channelId
      return true
    }),
    leaveVoiceChannel: vi.fn(async () => {
      const room = store.currentChannelId || store.optimisticChannelId
      if (store.optimisticChannelId) {
        join.aborted = true
        join.release?.()
      }
      store.isConnected = false
      store.currentChannelId = null
      if (room?.startsWith('dm-')) await dmCallSignaling.leaveCall(room.slice(3), 'me')
      return true
    }),
  })
  return { useUnifiedVoiceChannelStore: () => store }
})

vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentProfileId: async () => 'me',
    getCurrentContext: async () => ({ isAuthenticated: true, profileId: 'me' }),
  },
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'auth-me' } } }) }))
vi.mock('@/stores/useDM', () => ({ useDMStore: () => ({ conversations: [], currentDMMessages: [] }) }))
vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({
    getUserDisplayName: () => ({ value: 'Them' }),
    subscribeToProfilePresence: async () => 'ctx',
    unsubscribeFromProfilePresence: async () => {},
    getPresenceAwareStatus: () => ({ value: 'online' }),
  }),
}))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: async () => true }) }))
const callSwitch = vi.hoisted(() => ({ leaveCurrentCallFor: vi.fn(async () => true) }))
vi.mock('@/composables/useCallSwitch', () => ({
  dmConversationIdFromChannel: (channelId: string | null) => (channelId?.startsWith('dm-') ? channelId.slice(3) : null),
  useCallSwitch: () => callSwitch,
}))
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/services/encryption/MegolmMessageEncryptionService', () => ({
  megolmMessageEncryptionService: { isUnlocked: () => false },
}))
const stub = vi.hoisted(() => (name: string) => ({ default: { name, render: () => null } }))
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/GroupIcon.vue', () => stub('GroupIcon'))
vi.mock('@/components/DisplayName.vue', () => stub('DisplayName'))
vi.mock('@/components/dm/GroupSettingsModal.vue', () => stub('GroupSettingsModal'))
vi.mock('@/components/search/MessageSearchModal.vue', () => stub('MessageSearchModal'))

import DMHeader from '../DMHeader.vue'
import { dmCallSignaling } from '@/services/DMCallSignaling'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'

const CONV = '11111111-1111-1111-1111-111111111111'

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

const conversation = {
  id: CONV,
  type: 'direct',
  other_user: { id: 'them', username: 'them', is_local: true },
  participants: [],
} as any

const answer = (type: 'decline' | 'busy' | 'timeout') => {
  const channel = rt.channels.find((c) => c.topic === `dm-call:${CONV}`)
  channel.handlers['broadcast:call-signal']({
    payload: { type, callerId: 'them', callType: 'voice', timestamp: Date.now(), conversationId: CONV, reason: type === 'decline' ? undefined : type },
  })
}

const rang = () => playAudio.mock.calls.some(([sound]) => sound === 'call_outgoing')

let wrapper: VueWrapper | null = null
const mountHeader = () => {
  wrapper = shallowMount(DMHeader, {
    props: { conversation },
    global: { directives: { 'click-outside': {} } },
  })
  return wrapper
}

beforeEach(() => {
  dmCallSignaling.cleanup()
  rt.channels.length = 0
  rt.rpc.mockReset().mockImplementation(rt.rpcResult)
  playAudio.mockClear()
  Object.values(toast).forEach((fn) => fn.mockClear())
  permissions.canPlaceCall.mockReset().mockResolvedValue({ allowed: true })
  callSwitch.leaveCurrentCallFor.mockReset().mockResolvedValue(true)
  join.release = null
  join.aborted = false
  const voice = useUnifiedVoiceChannelStore() as any
  voice.isConnected = false
  voice.currentChannelId = null
  voice.optimisticChannelId = null
  voice.joinVoiceChannel.mockClear()
  voice.leaveVoiceChannel.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('DMHeader outgoing call', () => {
  it('rings while the call is unanswered', async () => {
    const header = mountHeader()
    await settle()
    await header.find('.voice-btn').trigger('click')
    await settle()
    join.release?.()
    await settle()

    expect(rang()).toBe(true)
    expect(dmCallSignaling.getActiveCall(CONV)?.ringing).toBe(true)
  })

  it('a caller-side refusal places no call and plays no jingle', async () => {
    permissions.canPlaceCall.mockResolvedValue({ allowed: false, reason: 'blocked', message: 'You cannot call this user' })
    const header = mountHeader()
    await settle()
    await header.find('.voice-btn').trigger('click')
    await settle()

    expect(toast.error).toHaveBeenCalledWith('You cannot call this user')
    expect(useUnifiedVoiceChannelStore().joinVoiceChannel).not.toHaveBeenCalled()
    expect(rt.rpc).not.toHaveBeenCalledWith('ring_dm_call', expect.anything())
    expect(rang()).toBe(false)
  })

  it('a refused call never asks to switch calls or leaves the current channel', async () => {
    permissions.canPlaceCall.mockResolvedValue({ allowed: false, reason: 'dnd', message: 'This user is in Do Not Disturb mode' })
    const header = mountHeader()
    await settle()
    await header.find('.voice-btn').trigger('click')
    await header.find('.video-btn').trigger('click')
    await settle()

    expect(permissions.canPlaceCall).toHaveBeenCalledTimes(2)
    expect(callSwitch.leaveCurrentCallFor).not.toHaveBeenCalled()
    expect(useUnifiedVoiceChannelStore().leaveVoiceChannel).not.toHaveBeenCalled()
  })

  it('an allowed call asks to switch calls after the pre-check, before ringing', async () => {
    const order: string[] = []
    permissions.canPlaceCall.mockImplementation(async () => { order.push('check'); return { allowed: true } })
    callSwitch.leaveCurrentCallFor.mockImplementation(async () => { order.push('switch'); return true })
    rt.rpc.mockImplementation(async (name: string) => {
      order.push(name)
      return { data: name === 'start_dm_call_message' ? 'msg-1' : 1, error: null }
    })
    const header = mountHeader()
    await settle()
    await header.find('.voice-btn').trigger('click')
    await settle()

    expect(order.slice(0, 3)).toEqual(['check', 'switch', 'start_dm_call_message'])
  })

  it('a decline that lands during the join leaves the caller in the call without a jingle', async () => {
    const header = mountHeader()
    await settle()
    await header.find('.voice-btn').trigger('click')
    await settle()
    answer('decline')
    await settle()
    join.release?.()
    await settle()

    expect(toast.info).toHaveBeenCalledWith('Call declined')
    expect(rang()).toBe(false)
    expect(useUnifiedVoiceChannelStore().leaveVoiceChannel).not.toHaveBeenCalled()
    expect(useUnifiedVoiceChannelStore().isConnected).toBe(true)
  })

  it('a busy answer during the join ends the direct call without a jingle or an error', async () => {
    const header = mountHeader()
    await settle()
    await header.find('.voice-btn').trigger('click')
    await settle()
    answer('busy')
    await settle()

    expect(toast.info).toHaveBeenCalledWith('User is busy')
    expect(rang()).toBe(false)
    expect(toast.error).not.toHaveBeenCalled()
    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(false)
    expect(useUnifiedVoiceChannelStore().isConnectedOrJoining).toBe(false)
    expect(rt.rpc).toHaveBeenCalledWith('ring_dm_call', expect.objectContaining({ p_signal: 'end', p_receiver_ids: ['them'] }))
  })

  it('a receiver hearing the caller\'s ring time out shows no "No answer" and stays in its call', async () => {
    const voice = useUnifiedVoiceChannelStore() as any
    voice.isConnected = true
    voice.currentChannelId = `dm-${CONV}`
    mountHeader()
    await settle()
    answer('timeout')
    await settle()

    expect(toast.info).not.toHaveBeenCalledWith('No answer')
    expect(voice.leaveVoiceChannel).not.toHaveBeenCalled()
  })

  it('a busy answer after the join stops the jingle and leaves the call', async () => {
    const header = mountHeader()
    await settle()
    await header.find('.voice-btn').trigger('click')
    await settle()
    join.release?.()
    await settle()
    expect(rang()).toBe(true)

    answer('busy')
    await settle()
    expect(useUnifiedVoiceChannelStore().leaveVoiceChannel).toHaveBeenCalled()
    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(false)
  })
})

describe('DMHeader Join', () => {
  const present = () => [{ callType: 'voice', joinedAt: new Date().toISOString(), isCaller: true, systemMessageId: null }]

  it('Join on a call everyone has left does not join, says the call ended and goes', async () => {
    const header = mountHeader()
    await settle()
    const channel = rt.channels.find((c) => c.topic === `dm-call:${CONV}`)
    channel.presenceState.mockReturnValue({ them: present() })
    channel.handlers['presence:sync']()
    await settle()
    expect(header.find('.join-call-btn').exists()).toBe(true)

    channel.presenceState.mockReturnValue({})
    channel.handlers['presence:sync']()
    await header.find('.join-call-btn').trigger('click')
    await settle()

    expect(useUnifiedVoiceChannelStore().joinVoiceChannel).not.toHaveBeenCalled()
    expect(channel.sent.filter((m: any) => m.payload?.type === 'join')).toEqual([])
    expect(toast.info).toHaveBeenCalledWith('Call ended')
    expect(header.find('.join-call-btn').exists()).toBe(false)
  })
})
