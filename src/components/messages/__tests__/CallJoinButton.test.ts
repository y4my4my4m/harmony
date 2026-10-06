/**
 * CallJoinButton.vue, the Join of a "started a call" message. It is offered
 * while the message's call is tracked and joins through useDMCallJoin: a call
 * whose presence is gone is not joined, reads "Call ended" and loses its Join.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

const CONV = '11111111-1111-1111-1111-111111111111'

const rt = vi.hoisted(() => {
  const channels: any[] = []
  const make = (topic: string) => {
    const handlers: Record<string, (payload?: any) => void> = {}
    const channel: any = {
      topic,
      handlers,
      sent: [] as any[],
      on: vi.fn((type: string, filter: { event: string }, cb: (payload?: any) => void) => {
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
  supabase: { channel: (topic: string) => rt.make(topic), rpc: rt.rpc },
}))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentProfileId: async () => 'me' },
}))
vi.mock('@/stores/useDM', () => ({ useDMStore: () => ({ currentDMMessages: [] }) }))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const voice = vi.hoisted(() => ({
  isConnected: false,
  currentChannelId: null as string | null,
  isOverlayVisible: false,
  joinError: null as string | null,
  joinVoiceChannel: vi.fn(async () => true),
}))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => voice }))
const callSwitch = vi.hoisted(() => ({ leaveCurrentCallFor: vi.fn(async () => true) }))
vi.mock('@/composables/useCallSwitch', () => ({ useCallSwitch: () => callSwitch }))
const listener = vi.hoisted(() => ({ dismissIncomingCall: vi.fn() }))
vi.mock('@/services/GlobalDMCallListener', () => ({ globalDMCallListener: listener }))

import CallJoinButton from '../CallJoinButton.vue'
import { dmCallSignaling } from '@/services/DMCallSignaling'

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}
const present = () => [{ callType: 'voice', joinedAt: new Date().toISOString(), isCaller: true, systemMessageId: 'msg-1' }]
const callChannel = () => rt.channels.find((c) => c.topic === `dm-call:${CONV}`)
const joins = (channel: any) => channel.sent.filter((m: any) => m.payload?.type === 'join')

// Rung and answered elsewhere; the conversation's channel is not open.
const answeredCall = () => {
  dmCallSignaling.registerRemoteCall(CONV, 'them', 'voice', 'msg-1')
  dmCallSignaling.handleRemoteSignal({ type: 'join', callerId: 'other', callType: 'voice', timestamp: 1, conversationId: CONV })
}

let wrapper: VueWrapper | null = null
const mountButton = (messageId = 'msg-1') => {
  wrapper = mount(CallJoinButton, { props: { messageId, conversationId: CONV } })
  return wrapper
}

beforeEach(() => {
  dmCallSignaling.cleanup()
  rt.channels.length = 0
  rt.rpc.mockClear()
  Object.values(toast).forEach((fn) => fn.mockClear())
  listener.dismissIncomingCall.mockClear()
  callSwitch.leaveCurrentCallFor.mockReset().mockResolvedValue(true)
  voice.joinVoiceChannel.mockReset().mockResolvedValue(true)
  voice.isConnected = false
  voice.currentChannelId = null
  voice.isOverlayVisible = false
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  dmCallSignaling.cleanup()
})

describe('call message Join', () => {
  it('is offered for the tracked call\'s own message only', async () => {
    expect(mountButton().find('.call-join-btn').exists()).toBe(false)
    answeredCall()
    await nextTick()
    expect(wrapper!.find('.call-join-btn').exists()).toBe(true)
    wrapper!.unmount()
    expect(mountButton('msg-0').find('.call-join-btn').exists()).toBe(false)
  })

  it('Join on a call nobody is present in any more does not join, says the call ended and goes', async () => {
    answeredCall()
    const w = mountButton()
    await w.find('.call-join-btn').trigger('click')
    await settle()

    // One presence check on the call topic, which shows nobody.
    const channel = callChannel()
    channel.handlers['presence:sync']()
    await settle()

    expect(voice.joinVoiceChannel).not.toHaveBeenCalled()
    expect(joins(channel)).toEqual([])
    expect(toast.info).toHaveBeenCalledWith('Call ended')
    expect(w.find('.call-join-btn').exists()).toBe(false)
    expect(dmCallSignaling.hasActiveCall(CONV)).toBe(false)
    expect(channel.unsubscribe).toHaveBeenCalled()
  })

  it('Join on a live call joins through the shared join', async () => {
    answeredCall()
    const w = mountButton()
    await w.find('.call-join-btn').trigger('click')
    await settle()

    const channel = callChannel()
    channel.presenceState.mockReturnValue({ them: present() })
    channel.handlers['presence:sync']()
    await settle()

    expect(listener.dismissIncomingCall).toHaveBeenCalledWith(CONV)
    expect(callSwitch.leaveCurrentCallFor).toHaveBeenCalledWith(`dm-${CONV}`)
    expect(joins(channel)).toHaveLength(1)
    expect(voice.joinVoiceChannel).toHaveBeenCalledWith(`dm-${CONV}`, 'dm')
    expect(voice.isOverlayVisible).toBe(true)
    expect(toast.info).not.toHaveBeenCalled()
  })
})
