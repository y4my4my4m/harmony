import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Server mute and deafen lock this client's own controls and apply themselves;
// lifting one returns the member's own choice. STREAM gates camera and screen
// share. A moderator's move takes the client to the destination; a disconnect
// takes it out of voice.

const handlers = vi.hoisted(() => ({} as Record<string, (payload: any) => unknown>))
const local = vi.hoisted(() => ({
  state: { userId: 'me', isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: false, isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0 },
}))
const webrtc = vi.hoisted(() => ({
  on: (event: string, cb: (payload: any) => unknown) => { handlers[event] = cb },
  getLocalState: vi.fn(() => ({ ...local.state })),
  getLocalStream: vi.fn(() => null),
  setMuted: vi.fn((muted: boolean) => { local.state.isMuted = muted }),
  toggleMute: vi.fn(() => { local.state.isMuted = !local.state.isMuted; return local.state.isMuted }),
  toggleDeafen: vi.fn(() => {
    local.state.isDeafened = !local.state.isDeafened
    if (local.state.isDeafened) local.state.isMuted = true
    return local.state.isDeafened
  }),
  toggleScreenShare: vi.fn(async () => { local.state.isScreenSharing = !local.state.isScreenSharing; return local.state.isScreenSharing }),
  toggleVideo: vi.fn(async () => { local.state.isVideoEnabled = !local.state.isVideoEnabled; return local.state.isVideoEnabled }),
  leaveChannel: vi.fn(async () => undefined),
}))
const toasts = vi.hoisted(() => ({ showToast: vi.fn() }))
const api = vi.hoisted(() => ({
  fetchMyVoiceState: vi.fn(),
  fetchServerVoiceModeration: vi.fn(async () => ({})),
  setServerVoiceState: vi.fn(),
  moveVoiceMember: vi.fn(),
  syncVoiceMember: vi.fn(),
}))

vi.mock('@/supabase', () => ({ supabase: { realtime: { isConnected: () => false } } }))
vi.mock('@/services/UserEventChannel', () => ({ userEventChannel: { on: () => () => {} } }))
vi.mock('@/services/instanceConfig', () => ({ apiUrl: (p: string) => p }))
vi.mock('@/services/webrtcManager', () => ({ webrtcManager: webrtc }))
vi.mock('@/services/voice/remoteAudioMixer', () => ({ clampVolume: (v: number) => v, remoteAudioMixer: { onBlockedChange: vi.fn() } }))
vi.mock('@/services/voice/voiceAudioPrefs', () => ({ loadAudioPrefs: () => ({}), saveMutes: vi.fn(), saveVolumes: vi.fn() }))
vi.mock('@/services/voice/voiceAudioContext', () => ({ closeVoiceAudioContext: vi.fn() }))
vi.mock('@/services/VoiceSettingsService', () => ({ VoiceSettingsService: { getAll: () => ({}) }, normalizeOutputVolume: (v: number) => v }))
vi.mock('@/services/spatialAudio', () => ({ spatialAudioService: {} }))
vi.mock('@/services/DMCallSignaling', () => ({ dmCallSignaling: {} }))
vi.mock('@/stores/spatialAudio', () => ({ useSpatialAudioStore: () => ({}) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'me' } } }) }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => ({ usersInVoiceChannels: {} }) }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ channels: [{ id: 'annex', name: 'annex', type: 1 }], servers: [], currentServer: { id: 's', is_local_server: true } }),
}))
vi.mock('@/services/callForegroundService', () => ({ setCallServiceActive: vi.fn() }))
vi.mock('@/services/overlayBridge', () => ({ syncOverlayForCall: vi.fn() }))
vi.mock('@/stores/useTheme', () => ({ useThemeStore: () => ({ playAudio: vi.fn() }) }))
vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => toasts }))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({}) }))
vi.mock('@/composables/useAnnouncer', () => ({ announce: vi.fn() }))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('@/services/voice/voiceAnnouncements', () => ({ voiceAnnouncer: new Proxy({}, { get: () => () => undefined }) }))
vi.mock('@/composables/useKeybinds', () => ({ useKeybinds: () => ({}) }))
vi.mock('@/services/encryption/VoiceE2EEService', () => ({ voiceE2EEService: {} }))
vi.mock('@/services/ChannelEncryptionService', () => ({ fetchEffectiveChannelEncryption: vi.fn() }))
vi.mock('@/utils/userScopedStorage', () => ({ userStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() } }))
vi.mock('@/services/voice/voiceModerationApi', () => api)

async function stores() {
  vi.resetModules()
  const { useUnifiedVoiceChannelStore } = await import('@/stores/unifiedVoiceChannel')
  const { useVoiceModerationStore } = await import('@/stores/voiceModeration')
  const voice = useUnifiedVoiceChannelStore() as any
  voice.setupWebRTCListeners()
  voice.$patch({ isConnected: true, currentServerId: 's', currentChannelId: 'lounge', localState: { ...local.state } })
  return { voice, moderation: useVoiceModerationStore() }
}

beforeEach(() => {
  setActivePinia(createPinia())
  for (const k of Object.keys(handlers)) delete handlers[k]
  Object.assign(local.state, { isMuted: false, isDeafened: false, isScreenSharing: false, isVideoEnabled: false })
  for (const fn of [...Object.values(webrtc), ...Object.values(api), toasts.showToast]) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as any).mockClear()
  }
})

describe('server mute', () => {
  it('mutes the member, locks unmute, and lifts back to the member\'s own choice', async () => {
    const { voice, moderation } = await stores()
    moderation.apply('s', 'me', { muted: true, deafened: false })
    expect(voice.speakLocked).toBe(true)
    expect(voice.speakLockReason).toBe('voice.moderation.serverMutedHint')

    await voice.enforceVoiceLocks()
    expect(webrtc.setMuted).toHaveBeenLastCalledWith(true)
    expect(voice.localState.isMuted).toBe(true)

    await voice.toggleMute()
    expect(webrtc.toggleMute).not.toHaveBeenCalled()
    expect(voice.localState.isMuted).toBe(true)
    await vi.waitFor(() => expect(toasts.showToast).toHaveBeenCalledWith('server_update', 'voice.moderation.lockedTitle', 'voice.moderation.serverMutedHint', 5000))

    voice.setMuted(false)
    expect(voice.localState.isMuted).toBe(true)

    moderation.apply('s', 'me', { muted: false, deafened: false })
    await voice.enforceVoiceLocks()
    expect(webrtc.setMuted).toHaveBeenLastCalledWith(false)
    expect(voice.localState.isMuted).toBe(false)
  })

  it('keeps a member who muted themselves muted when the server mute lifts', async () => {
    const { voice, moderation } = await stores()
    local.state.isMuted = true
    voice.localState.isMuted = true
    moderation.apply('s', 'me', { muted: true, deafened: false })
    await voice.enforceVoiceLocks()
    moderation.apply('s', 'me', { muted: false, deafened: false })
    await voice.enforceVoiceLocks()
    expect(webrtc.setMuted).not.toHaveBeenCalled()
    expect(voice.localState.isMuted).toBe(true)
  })

  it('follows the participant metadata a remote host sets', async () => {
    const { voice } = await stores()
    handlers['moderation-flags']?.({ userId: 'me', muted: true, deafened: false })
    expect(voice.selfModeration).toEqual({ muted: true, deafened: false })
    expect(voice.speakLocked).toBe(true)
  })
})

describe('server deafen', () => {
  it('deafens, refuses undeafen, and lifts', async () => {
    const { voice, moderation } = await stores()
    moderation.apply('s', 'me', { muted: false, deafened: true })
    expect(voice.deafenLocked).toBe(true)
    await voice.enforceVoiceLocks()
    expect(voice.localState).toMatchObject({ isDeafened: true, isMuted: true })

    await voice.toggleDeafen()
    expect(voice.localState.isDeafened).toBe(true)
    expect(webrtc.toggleDeafen).toHaveBeenCalledTimes(1)

    moderation.apply('s', 'me', { muted: false, deafened: false })
    await voice.enforceVoiceLocks()
    expect(voice.localState).toMatchObject({ isDeafened: false, isMuted: false })
  })
})

describe('grants', () => {
  it('without SPEAK the microphone stays muted and explains why', async () => {
    const { voice } = await stores()
    handlers['local-grants-changed']?.({ speak: false, stream: true, hear: true })
    expect(voice.speakLockReason).toBe('voice.moderation.noSpeakHint')
    await voice.enforceVoiceLocks()
    expect(voice.localState.isMuted).toBe(true)
  })

  it('without STREAM there is no screen share or camera, and a running one ends', async () => {
    const { voice } = await stores()
    local.state.isScreenSharing = true
    voice.localState.isScreenSharing = true
    handlers['local-grants-changed']?.({ speak: true, stream: false, hear: true })
    expect(voice.canStream).toBe(false)
    await voice.enforceVoiceLocks()
    expect(webrtc.toggleScreenShare).toHaveBeenCalledTimes(1)
    expect(voice.localState.isScreenSharing).toBe(false)

    expect(await voice.toggleScreenShare()).toBe(false)
    expect(await voice.toggleVideo()).toBe(false)
    expect(webrtc.toggleScreenShare).toHaveBeenCalledTimes(1)
    expect(webrtc.toggleVideo).not.toHaveBeenCalled()
  })
})

describe('departures', () => {
  it('a move takes the client to the destination', async () => {
    const { voice, moderation } = await stores()
    voice.joinVoiceChannel = vi.fn(async () => true)
    await moderation.followDeparture('s', 'lounge', 'annex', 'moved')
    expect(voice.joinVoiceChannel).toHaveBeenCalledWith('annex', 's', { local: true })
  })

  it('a disconnect takes it out of voice; a departure from another channel is ignored', async () => {
    const { voice, moderation } = await stores()
    voice.leaveVoiceChannel = vi.fn(async () => true)
    await moderation.followDeparture('s', 'elsewhere', null, 'disconnected')
    expect(voice.leaveVoiceChannel).not.toHaveBeenCalled()
    await moderation.followDeparture('s', 'lounge', null, 'removed')
    expect(voice.leaveVoiceChannel).toHaveBeenCalledTimes(1)
    expect(toasts.showToast).toHaveBeenCalledWith('server_update', 'voice.moderation.youWereDisconnectedTitle', 'voice.moderation.youWereRemoved', 6000)
  })

  it('my_voice_state follows a move while realtime is down, and a row seen and then gone on two polls', async () => {
    const { voice, moderation } = await stores()
    voice.joinVoiceChannel = vi.fn(async () => true)
    voice.leaveVoiceChannel = vi.fn(async () => true)

    api.fetchMyVoiceState.mockResolvedValueOnce({ channelId: null, moveChannelId: null, muted: false, deafened: false })
    await moderation.pollSelf()
    expect(voice.leaveVoiceChannel).not.toHaveBeenCalled()

    api.fetchMyVoiceState.mockResolvedValueOnce({ channelId: 'lounge', moveChannelId: null, muted: true, deafened: false })
    await moderation.pollSelf()
    expect(voice.selfModeration.muted).toBe(true)

    api.fetchMyVoiceState.mockResolvedValueOnce({ channelId: null, moveChannelId: 'annex', muted: false, deafened: false })
    await moderation.pollSelf()
    expect(voice.joinVoiceChannel).toHaveBeenCalledWith('annex', 's', { local: true })

    api.fetchMyVoiceState.mockResolvedValueOnce({ channelId: 'lounge', moveChannelId: null, muted: false, deafened: false })
    await moderation.pollSelf()
    api.fetchMyVoiceState.mockResolvedValueOnce({ channelId: null, moveChannelId: null, muted: false, deafened: false })
    await moderation.pollSelf()
    expect(voice.leaveVoiceChannel).not.toHaveBeenCalled()
    api.fetchMyVoiceState.mockResolvedValueOnce({ channelId: null, moveChannelId: null, muted: false, deafened: false })
    await moderation.pollSelf()
    expect(voice.leaveVoiceChannel).toHaveBeenCalledTimes(1)
  })
})
