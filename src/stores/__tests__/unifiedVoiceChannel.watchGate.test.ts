import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// A LiveKit stream renders only after the viewer chooses to watch it, including while the join
// is still in flight (connectionMode null). P2P streams are always received.

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

const { useUnifiedVoiceChannelStore } = await import('../unifiedVoiceChannel')

describe('isWatchingStream', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('does not count a remote stream as watched while the LiveKit join is in flight', () => {
    const store = useUnifiedVoiceChannelStore()
    store.connectionMode = null
    expect(store.isWatchingStream('streamer')).toBe(false)
    store.watchedStreamUserIds = ['streamer']
    expect(store.isWatchingStream('streamer')).toBe(true)
  })

  it('counts P2P streams and the viewer\'s own stream as watched', () => {
    const store = useUnifiedVoiceChannelStore()
    store.connectionMode = 'p2p'
    expect(store.isWatchingStream('streamer')).toBe(true)
    store.connectionMode = 'livekit'
    expect(store.isWatchingStream('streamer')).toBe(false)
    expect(store.isWatchingStream(store.localState.userId)).toBe(true)
  })
})
