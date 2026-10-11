import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Store wiring of the spoken voice events: transport events and own toggles
// reach voiceAnnouncer; participants present at the handshake are not
// announced as arrivals; a dropped connection leaves the speaking to its toast.

const handlers = vi.hoisted(() => ({} as Record<string, (payload: any) => unknown>))
const local = vi.hoisted(() => ({ isMuted: false, isDeafened: false }))
const webrtc = vi.hoisted(() => ({
  on: (event: string, cb: (payload: any) => unknown) => { handlers[event] = cb },
  leaveChannel: vi.fn(async () => undefined),
  toggleMute: vi.fn(() => { local.isMuted = !local.isMuted; return local.isMuted }),
  toggleDeafen: vi.fn(() => { local.isDeafened = !local.isDeafened; return local.isDeafened }),
  getLocalState: () => ({
    userId: 'me', isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: false,
    isMuted: local.isMuted, isDeafened: local.isDeafened, isSpeaking: false, audioLevel: 0,
  }),
}))
const announcer = vi.hoisted(() => ({
  participantJoined: vi.fn(),
  participantLeft: vi.fn(),
  streamChanged: vi.fn(),
  selfStreamChanged: vi.fn(),
  connecting: vi.fn(),
  connected: vi.fn(),
  reconnected: vi.fn(),
  disconnected: vi.fn(),
  selfMuted: vi.fn(),
  selfDeafened: vi.fn(),
  selfCamera: vi.fn(),
  speakingChanged: vi.fn(),
}))
const playAudio = vi.hoisted(() => vi.fn())

vi.mock('@/services/voice/voiceAnnouncements', () => ({ voiceAnnouncer: announcer }))
vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/services/UserEventChannel', () => ({ userEventChannel: { on: () => () => {} } }))
vi.mock('@/services/instanceConfig', () => ({ apiUrl: (p: string) => p }))
vi.mock('@/services/webrtcManager', () => ({ webrtcManager: webrtc }))
vi.mock('@/services/voice/remoteAudioMixer', () => ({
  clampVolume: (v: number) => v,
  remoteAudioMixer: { onBlockedChange: vi.fn() },
}))
vi.mock('@/services/voice/voiceAudioPrefs', () => ({ loadAudioPrefs: () => ({}), saveMutes: vi.fn(), saveVolumes: vi.fn() }))
vi.mock('@/services/voice/voiceAudioContext', () => ({ closeVoiceAudioContext: vi.fn() }))
vi.mock('@/services/VoiceSettingsService', () => ({ VoiceSettingsService: {}, normalizeOutputVolume: (v: number) => v }))
vi.mock('@/services/spatialAudio', () => ({ spatialAudioService: { removeUser: vi.fn(), destroy: vi.fn() } }))
vi.mock('@/services/DMCallSignaling', () => ({ dmCallSignaling: {} }))
vi.mock('@/stores/spatialAudio', () => ({ useSpatialAudioStore: () => ({}) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'me' } } }) }))
vi.mock('@/stores/useServerUsers', () => ({
  useServerUsersStore: () => ({ cleanupDisconnectedUser: vi.fn(), leaveVoiceChannel: vi.fn(async () => true) }),
}))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ channels: [] }) }))
vi.mock('@/services/callForegroundService', () => ({ setCallServiceActive: vi.fn() }))
vi.mock('@/services/overlayBridge', () => ({ syncOverlayForCall: vi.fn() }))
vi.mock('@/stores/useTheme', () => ({ useThemeStore: () => ({ playAudio }) }))
vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => ({ showToast: vi.fn() }) }))
vi.mock('@/stores/soundboard', () => ({ useSoundboardStore: () => ({ leaveCall: vi.fn(), receive: vi.fn() }) }))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({ ensureProfilesAvailable: vi.fn(async () => undefined) }) }))
vi.mock('@/composables/useKeybinds', () => ({ useKeybinds: () => ({}) }))
vi.mock('@/services/encryption/VoiceE2EEService', () => ({ voiceE2EEService: {} }))
vi.mock('@/services/ChannelEncryptionService', () => ({ fetchEffectiveChannelEncryption: vi.fn() }))
vi.mock('@/utils/userScopedStorage', () => ({ userStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() } }))

import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'

const member = (userId: string, extra: Record<string, unknown> = {}) => ({
  userId, isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: false,
  isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0, ...extra,
})

// Listeners register once per module and bind the first store.
function store(connected = true) {
  const s = useUnifiedVoiceChannelStore() as any
  s.resetState()
  s.cleanupSpatialAudio = vi.fn()
  s.cleanupPushToTalk = vi.fn()
  s.removeUserFromSpatialAudio = vi.fn()
  s.requestCallStartTime = vi.fn()
  s.setupWebRTCListeners()
  s.localState = webrtc.getLocalState()
  s.isConnected = connected
  s.currentChannelId = 'c1'
  s.currentServerId = 's1'
  s.currentChannelName = 'General'
  s.connectionState = connected ? 'connected' : null
  return s
}

const emit = (event: string, payload?: any) => handlers[event]?.(payload)

beforeAll(() => {
  setActivePinia(createPinia())
})

beforeEach(() => {
  Object.values(announcer).forEach((fn) => fn.mockClear())
  local.isMuted = false
  local.isDeafened = false
})

describe('voice announcements wiring', () => {
  it('announces a participant who arrives after the connection', async () => {
    store()
    await emit('user-joined', { userId: 'alice', mediaState: member('alice') })
    expect(announcer.participantJoined).toHaveBeenCalledWith('alice')
  })

  it('stays quiet about participants already in the room during the handshake', async () => {
    store(false)
    await emit('user-joined', { userId: 'bob', mediaState: member('bob') })
    expect(announcer.participantJoined).not.toHaveBeenCalled()
  })

  it('announces a departure', () => {
    const s = store()
    s.allUsers = [member('alice')]
    emit('user-left', { userId: 'alice' })
    expect(announcer.participantLeft).toHaveBeenCalledWith('alice')
  })

  it('announces a remote stream starting and stopping, not other state changes', () => {
    const s = store()
    s.allUsers = [member('carol')]
    emit('user-state-changed', { userId: 'carol', mediaState: member('carol', { isMuted: true }) })
    expect(announcer.streamChanged).not.toHaveBeenCalled()
    emit('user-state-changed', { userId: 'carol', mediaState: member('carol', { isScreenSharing: true }) })
    emit('user-state-changed', { userId: 'carol', mediaState: member('carol', { isScreenSharing: false }) })
    expect(announcer.streamChanged.mock.calls).toEqual([['carol', true], ['carol', false]])
  })

  it('passes every remote audio level to the speaking rules', () => {
    const s = store()
    s.allUsers = [member('alice')]
    emit('audio-level', { userId: 'alice', level: 40 })
    emit('audio-level', { userId: 'alice', level: 2 })
    expect(announcer.speakingChanged.mock.calls).toEqual([['alice', true], ['alice', false]])
  })

  it('announces own mute and deafen however they were toggled', async () => {
    const s = store()
    await s.toggleMute()
    await s.toggleMute()
    await s.toggleDeafen()
    expect(announcer.selfMuted.mock.calls).toEqual([[true], [false]])
    expect(announcer.selfDeafened.mock.calls).toEqual([[true]])
  })

  it('announces a preemptive mute while not in a call', async () => {
    const s = store(false)
    await s.toggleMute()
    expect(announcer.selfMuted).toHaveBeenCalledWith(true)
  })

  it('announces own camera and stream changes from the transport', () => {
    store()
    emit('local-state-changed', { ...webrtc.getLocalState(), isVideoEnabled: true })
    emit('local-state-changed', { ...webrtc.getLocalState(), isVideoEnabled: true, isScreenSharing: true })
    expect(announcer.selfCamera).toHaveBeenCalledWith(true)
    expect(announcer.selfStreamChanged).toHaveBeenCalledWith(true)
  })

  it('announces the recovery of a reconnecting link once', () => {
    store()
    emit('connection-state-changed', { state: 'reconnecting' })
    emit('connection-state-changed', { state: 'connected' })
    emit('connection-state-changed', { state: 'connected' })
    expect(announcer.reconnected).toHaveBeenCalledTimes(1)
  })

  it('plays the join sound and says where, once the transport is up', () => {
    const s = store()
    playAudio.mockClear()
    s.announceConnected()
    expect(playAudio).toHaveBeenCalledWith('voice_connect')
    expect(announcer.connected).toHaveBeenCalledWith('General')
  })

  it('says "Disconnected" on a leave, not on a dropped connection', async () => {
    let s = store()
    await s.leaveVoiceChannel()
    expect(announcer.disconnected).toHaveBeenCalledTimes(1)

    s = store()
    await s.leaveVoiceChannel({ lost: true })
    expect(announcer.disconnected).toHaveBeenCalledTimes(1)
  })
})
