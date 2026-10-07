import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The roster is the media transport's participant list once connected; voice
// presence seeds it only while the join is in flight. A presence occupant the
// transport never connects (an SFU user seen from a P2P session) must not
// stay on screen as a participant.

const handlers = vi.hoisted(() => ({} as Record<string, (payload: any) => unknown>))
const webrtc = vi.hoisted(() => ({
  on: (event: string, cb: (payload: any) => unknown) => { handlers[event] = cb },
  joinChannel: vi.fn(async () => true),
  getAllUsers: vi.fn(() => [] as any[]),
  getActiveService: vi.fn(() => 'livekit'),
  getLastJoinError: vi.fn(() => null as string | null),
  isE2EEEnabled: vi.fn(() => false),
  getLocalState: vi.fn(() => ({ userId: 'me' })),
  getLocalStream: vi.fn(() => null),
  leaveChannel: vi.fn(async () => undefined),
  preloadTransport: vi.fn(),
  setAutoWatchStreams: vi.fn(),
  setMasterVolume: vi.fn(),
}))
const serverUsers = vi.hoisted(() => ({
  getUsersInVoiceChannel: vi.fn(() => ['sfu-user']),
  joinVoiceChannel: vi.fn(async () => true),
  leaveVoiceChannel: vi.fn(async () => true),
  markVoiceTransport: vi.fn(async () => undefined),
  getCallStartTime: vi.fn(() => null),
}))

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
vi.mock('@/services/VoiceSettingsService', () => ({
  VoiceSettingsService: { getAll: () => ({ autoWatchStreams: false, outputVolume: 100 }) },
  normalizeOutputVolume: (v: number) => v,
}))
vi.mock('@/services/spatialAudio', () => ({ spatialAudioService: {} }))
vi.mock('@/services/DMCallSignaling', () => ({ dmCallSignaling: {} }))
vi.mock('@/stores/spatialAudio', () => ({ useSpatialAudioStore: () => ({}) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'me' } } }) }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => serverUsers }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ channels: [], currentServer: { is_local_server: true } }) }))
vi.mock('@/services/callForegroundService', () => ({ setCallServiceActive: vi.fn() }))
vi.mock('@/services/overlayBridge', () => ({ syncOverlayForCall: vi.fn() }))
vi.mock('@/stores/useTheme', () => ({ useThemeStore: () => ({ playAudio: vi.fn() }) }))
vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => ({ showToast: vi.fn() }) }))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({ ensureProfilesAvailable: async () => undefined }) }))
vi.mock('@/composables/useKeybinds', () => ({ useKeybinds: () => ({}) }))
vi.mock('@/services/encryption/VoiceE2EEService', () => ({ voiceE2EEService: { canParticipate: () => true } }))
vi.mock('@/services/ChannelEncryptionService', () => ({ fetchEffectiveChannelEncryption: vi.fn(async () => null) }))
vi.mock('@/utils/userScopedStorage', () => ({ userStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() } }))

const member = (userId: string) => ({
  userId, isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: false,
  isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0,
})

// The store registers its transport listeners once per module load.
async function store() {
  vi.resetModules()
  const { useUnifiedVoiceChannelStore } = await import('@/stores/unifiedVoiceChannel')
  const s = useUnifiedVoiceChannelStore() as any
  for (const action of ['syncTransmitGate', 'applyAudioPrefs', 'saveVoiceChannelState',
    'startVoiceSessionHeartbeat', 'setupPushToTalk', 'initializeSpatialAudio', 'loadAudioPrefs', 'loadStreamSettings']) {
    s[action] = vi.fn()
  }
  return s
}

beforeEach(() => {
  setActivePinia(createPinia())
  for (const k of Object.keys(handlers)) delete handlers[k]
  webrtc.getAllUsers.mockReset().mockReturnValue([])
  webrtc.getActiveService.mockReset().mockReturnValue('livekit')
  webrtc.getLastJoinError.mockReset().mockReturnValue(null)
  webrtc.joinChannel.mockReset()
})

describe('voice roster and transport state', () => {
  it('replaces the presence roster with the transport participants on join', async () => {
    const s = await store()
    webrtc.getActiveService.mockReturnValue('p2p')
    webrtc.joinChannel.mockImplementation(async () => {
      // Presence lists sfu-user; the P2P session connects nobody.
      expect(s.allUsers.map((u: any) => u.userId)).toEqual(['sfu-user'])
      handlers['channel-joined']?.({ channelId: 'chan', userId: 'me' })
      return true
    })

    await expect(s.joinVoiceChannel('chan', 'server')).resolves.toBe(true)
    expect(s.allUsers).toEqual([])
    expect(s.connectionStats.total).toBe(1)
    expect(serverUsers.markVoiceTransport).toHaveBeenCalledWith('chan', 'me', 'p2p')
  })

  it('keeps the remote participants the transport reports', async () => {
    const s = await store()
    // unifiedWebRTC.getAllUsers lists the local user first.
    webrtc.getAllUsers.mockReturnValue([member('me'), member('peer')])
    webrtc.joinChannel.mockImplementation(async () => {
      handlers['channel-joined']?.({ channelId: 'chan', userId: 'me' })
      return true
    })

    await s.joinVoiceChannel('chan', 'server')
    expect(s.allUsers.map((u: any) => u.userId)).toEqual(['peer'])
    expect(s.connectionStats.total).toBe(2)
  })

  it('reports why the transport refused the join', async () => {
    const s = await store()
    webrtc.joinChannel.mockResolvedValue(false)
    webrtc.getLastJoinError.mockReturnValue('Could not connect to the voice server: refused')

    await expect(s.joinVoiceChannel('chan', 'server')).resolves.toBe(false)
    expect(s.joinError).toBe('Could not connect to the voice server: refused')
    expect(s.allUsers).toEqual([])
    expect(serverUsers.leaveVoiceChannel).toHaveBeenCalledWith('server', 'chan', 'me')
  })

  it('labels the transport and shows nothing while not connected', async () => {
    const s = await store()
    expect(s.transportLabel).toBeNull()
    s.connectionMode = 'livekit'
    expect(s.transportLabel).toBe('SFU')
    s.connectionMode = 'p2p'
    expect(s.transportLabel).toBe('P2P')
  })
})
