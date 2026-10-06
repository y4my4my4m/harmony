import { describe, it, expect, vi, beforeEach } from 'vitest'

// Joining a conversation's live call from the conversation list: the local
// room for local calls, the federated accept for an unanswered federated ring.

const calls = vi.hoisted(() => ({ active: new Map<string, any>() }))
const signaling = vi.hoisted(() => ({
  joinCall: vi.fn(async () => true),
  acceptFederatedCall: vi.fn(async () => ({ token: 'T', wsUrl: 'wss://livekit.remote.test', roomName: 'federated-dm-x-1' })),
}))
vi.mock('@/services/DMCallSignaling', () => ({
  dmCallSignaling: {
    getActiveCall: (id: string) => calls.active.get(id),
    joinCall: signaling.joinCall,
    acceptFederatedCall: signaling.acceptFederatedCall,
  },
}))
const listener = vi.hoisted(() => ({ dismissIncomingCall: vi.fn() }))
vi.mock('@/services/GlobalDMCallListener', () => ({ globalDMCallListener: listener }))
vi.mock('@/services/AuthContextService', () => ({ authContextService: { getCurrentProfileId: async () => 'me' } }))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
const toast = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
const callSwitch = vi.hoisted(() => ({ leaveCurrentCallFor: vi.fn(async () => true) }))
vi.mock('@/composables/useCallSwitch', () => ({ useCallSwitch: () => callSwitch }))
const voice = vi.hoisted(() => ({
  isConnected: false,
  currentChannelId: null as string | null,
  isOverlayVisible: false,
  joinError: null as string | null,
  joinVoiceChannel: vi.fn(async () => true),
}))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => voice }))

import { useDMCallJoin } from '@/composables/useDMCallJoin'

beforeEach(() => {
  calls.active.clear()
  Object.values(signaling).forEach((fn) => fn.mockClear())
  listener.dismissIncomingCall.mockClear()
  toast.error.mockClear()
  callSwitch.leaveCurrentCallFor.mockReset().mockResolvedValue(true)
  voice.joinVoiceChannel.mockReset().mockResolvedValue(true)
  voice.isConnected = false
  voice.currentChannelId = null
  voice.isOverlayVisible = false
})

describe('useDMCallJoin', () => {
  it('joins a local call in its dm room and dismisses that conversation\'s ring', async () => {
    calls.active.set('conv', { ringing: true, callerId: 'caller' })
    await expect(useDMCallJoin().joinConversationCall('conv')).resolves.toBe(true)

    expect(callSwitch.leaveCurrentCallFor).toHaveBeenCalledWith('dm-conv')
    expect(listener.dismissIncomingCall).toHaveBeenCalledWith('conv')
    expect(signaling.joinCall).toHaveBeenCalledWith('conv', 'me')
    expect(voice.joinVoiceChannel).toHaveBeenCalledWith('dm-conv', 'dm')
    expect(voice.isOverlayVisible).toBe(true)
  })

  it('accepts an unanswered federated ring with the caller\'s room credentials', async () => {
    calls.active.set('conv', { ringing: true, isFederated: true, callerFederatedId: 'https://remote.test/users/a' })
    await expect(useDMCallJoin().joinConversationCall('conv')).resolves.toBe(true)

    expect(signaling.acceptFederatedCall).toHaveBeenCalledWith('conv', 'me', 'https://remote.test/users/a')
    expect(voice.joinVoiceChannel).toHaveBeenCalledWith('federated-dm-x-1', 'dm', {
      livekit: { wsUrl: 'wss://livekit.remote.test', token: 'T' },
    })
    expect(signaling.joinCall).not.toHaveBeenCalled()
  })

  it('does nothing without a live call or when the switch is declined', async () => {
    await expect(useDMCallJoin().joinConversationCall('conv')).resolves.toBe(false)
    calls.active.set('conv', { ringing: true })
    callSwitch.leaveCurrentCallFor.mockResolvedValue(false)
    await expect(useDMCallJoin().joinConversationCall('conv')).resolves.toBe(false)
    expect(voice.joinVoiceChannel).not.toHaveBeenCalled()
  })

  it('reports a failed join', async () => {
    calls.active.set('conv', { ringing: true })
    voice.joinVoiceChannel.mockResolvedValue(false)
    await expect(useDMCallJoin().joinConversationCall('conv')).resolves.toBe(false)
    expect(toast.error).toHaveBeenCalledWith('voice.joinCallFailed')
  })
})
