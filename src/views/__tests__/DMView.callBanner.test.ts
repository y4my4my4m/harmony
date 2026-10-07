/**
 * DMView.vue call banner. Join is the conversation list's join: a call nobody
 * is present in any more is not joined, reads "Call ended" and the banner
 * goes; a live call is joined through useDMCallJoin.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

const CONV = vi.hoisted(() => '11111111-1111-1111-1111-111111111111')

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

const conversation = vi.hoisted(() => ({
  id: CONV,
  type: 'direct',
  other_user: { id: 'them', username: 'them', is_local: true },
}))
vi.mock('@/stores/useDM', () => ({
  useDMStore: () => ({
    getCurrentConversation: conversation,
    conversations: [conversation],
    currentDMMessages: [],
    isCacheValid: () => true,
    loadCachedMessages: vi.fn(),
    initializeDMEnvironmentForDirectAccess: vi.fn(async () => conversation),
    fetchConversationMessages: vi.fn(async () => {}),
    clearDMMessages: vi.fn(),
    jumpToMessage: vi.fn(async () => true),
  }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { conversationId: CONV }, query: {} }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/composables/useLayoutState', async () => {
  const { ref } = await import('vue')
  return { useLayoutState: () => ({ isMobile: ref(false) }) }
})
vi.mock('@/composables/useUserData', async () => {
  const { ref } = await import('vue')
  return {
    useUserData: () => ({
      getCurrentUser: ref({ id: 'me', username: 'me' }),
      getUserDisplayName: () => ref('Them'),
      getUserAvatarUrl: () => ref(''),
    }),
  }
})
vi.mock('@/composables/useViewContext', () => ({ useViewContextTracking: vi.fn() }))
vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => ({ notifications: [], markAsRead: vi.fn() }) }))
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
vi.mock('@/stores/unifiedVoiceChannel', async () => {
  const { reactive } = await import('vue')
  const store = reactive(voice)
  return { useUnifiedVoiceChannelStore: () => store }
})
const callSwitch = vi.hoisted(() => ({ leaveCurrentCallFor: vi.fn(async () => true) }))
vi.mock('@/composables/useCallSwitch', () => ({
  dmConversationIdFromChannel: (channelId: string | null) => (channelId?.startsWith('dm-') ? channelId.slice(3) : null),
  useCallSwitch: () => callSwitch,
}))
const listener = vi.hoisted(() => ({ dismissIncomingCall: vi.fn() }))
vi.mock('@/services/GlobalDMCallListener', () => ({ globalDMCallListener: listener }))

const stub = vi.hoisted(() => (name: string) => ({ default: { name, render: () => null } }))
vi.mock('@/components/common/UnifiedContentArea.vue', () => stub('UnifiedContentArea'))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/dm/DMHeader.vue', () => stub('DMHeader'))
vi.mock('@/components/dm/FollowersList.vue', () => stub('FollowersList'))
vi.mock('@/components/dm/GroupChatInviteModal.vue', () => stub('GroupChatInviteModal'))
vi.mock('@/components/dm/IncomingCallModal.vue', () => stub('IncomingCallModal'))

import DMView from '../DMView.vue'
import { dmCallSignaling } from '@/services/DMCallSignaling'

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}
const present = () => [{ callType: 'voice', joinedAt: new Date().toISOString(), isCaller: true, systemMessageId: null }]

let wrapper: VueWrapper | null = null
let offHeader: (() => void) | null = null

// DMHeader holds the conversation's call channel; presence finds the call.
const openCall = async () => {
  offHeader = dmCallSignaling.subscribeToConversation(CONV, () => {})
  await settle()
  const channel = rt.channels.find((c) => c.topic === `dm-call:${CONV}`)
  channel.presenceState.mockReturnValue({ them: present() })
  channel.handlers['presence:sync']()
  return channel
}

const mountView = async () => {
  wrapper = shallowMount(DMView, { props: { isDM: true } })
  await nextTick()
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
  offHeader?.()
  offHeader = null
  dmCallSignaling.cleanup()
})

describe('DMView call banner', () => {
  it('Join on a call everyone has left does not join, says the call ended and drops the banner', async () => {
    const channel = await openCall()
    const w = await mountView()
    expect(w.find('.dm-call-banner').exists()).toBe(true)

    // Presence emptied; the call awaits its empty-presence grace.
    channel.presenceState.mockReturnValue({})
    channel.handlers['presence:sync']()
    await nextTick()
    expect(w.find('.dm-call-banner').exists()).toBe(true)

    await w.find('.call-banner-join').trigger('click')
    await settle()

    expect(voice.joinVoiceChannel).not.toHaveBeenCalled()
    expect(channel.sent.filter((m: any) => m.payload?.type === 'join')).toEqual([])
    expect(callSwitch.leaveCurrentCallFor).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith('Call ended')
    expect(w.find('.dm-call-banner').exists()).toBe(false)
  })

  it('Join on a live call joins through the shared join', async () => {
    const channel = await openCall()
    const w = await mountView()

    await w.find('.call-banner-join').trigger('click')
    await settle()

    expect(listener.dismissIncomingCall).toHaveBeenCalledWith(CONV)
    expect(callSwitch.leaveCurrentCallFor).toHaveBeenCalledWith(`dm-${CONV}`)
    expect(channel.sent.filter((m: any) => m.payload?.type === 'join')).toHaveLength(1)
    expect(voice.joinVoiceChannel).toHaveBeenCalledWith(`dm-${CONV}`, 'dm')
    expect(voice.isOverlayVisible).toBe(true)
    expect(toast.info).not.toHaveBeenCalled()
  })
})
