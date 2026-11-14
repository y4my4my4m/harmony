import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// A closing page leaves its server voice channel with a keepalive row delete, joined or still
// joining (the row is written before the transport connects); a DM call or a remote server's
// channel writes no row here and sends none.

const handlers = vi.hoisted(() => ({} as Record<string, (payload: any) => unknown>))
const webrtc = vi.hoisted(() => ({
  on: (event: string, cb: (payload: any) => unknown) => { handlers[event] = cb },
  leaveChannel: vi.fn(async () => undefined),
}))
const toast = vi.hoisted(() => vi.fn())
const stored = vi.hoisted(() => new Map<string, string>())
const serverUsers = vi.hoisted(() => ({ touchVoiceParticipant: vi.fn(async () => undefined), leaveVoiceChannelOnUnload: vi.fn() }))

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
vi.mock('@/services/spatialAudio', () => ({ spatialAudioService: {} }))
vi.mock('@/services/DMCallSignaling', () => ({ dmCallSignaling: {} }))
vi.mock('@/stores/spatialAudio', () => ({ useSpatialAudioStore: () => ({}) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'me' }, access_token: 'token' } }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: { id: 'me' } }) }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => serverUsers }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ channels: [] }) }))
vi.mock('@/services/callForegroundService', () => ({ setCallServiceActive: vi.fn() }))
vi.mock('@/services/overlayBridge', () => ({ syncOverlayForCall: vi.fn() }))
vi.mock('@/stores/useTheme', () => ({ useThemeStore: () => ({ playAudio: vi.fn() }) }))
vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => ({ showToast: toast }) }))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({}) }))
vi.mock('@/services/voice/voiceAnnouncements', () => ({
  voiceAnnouncer: new Proxy({}, { get: () => () => undefined }),
}))
vi.mock('@/composables/useKeybinds', () => ({ useKeybinds: () => ({}) }))
vi.mock('@/services/encryption/VoiceE2EEService', () => ({ voiceE2EEService: {} }))
vi.mock('@/services/ChannelEncryptionService', () => ({ fetchEffectiveChannelEncryption: vi.fn() }))
vi.mock('@/utils/userScopedStorage', () => ({
  userStorage: {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => { stored.set(k, v) },
    removeItem: (k: string) => { stored.delete(k) },
  },
}))

import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'

// The listeners register once per module and bind the store they were registered on.
function store() {
  setActivePinia(pinia)
  const s = useUnifiedVoiceChannelStore() as any
  s.resetState()
  s.setupWebRTCListeners()
  return s
}

const pinia = createPinia()
const unload = () => window.dispatchEvent(new Event('pagehide'))

beforeEach(() => {
  serverUsers.leaveVoiceChannelOnUnload.mockClear()
})

describe('a closing page', () => {
  it('leaves the joined channel', () => {
    const s = store()
    Object.assign(s, { isConnected: true, currentServerId: 's1', currentChannelId: 'c1' })
    s.localState.userId = 'me'
    unload()
    expect(serverUsers.leaveVoiceChannelOnUnload).toHaveBeenCalledWith('s1', 'c1', 'me', 'token')
  })

  it('leaves a channel it is still joining', () => {
    const s = store()
    Object.assign(s, { isConnected: false, isConnecting: true, optimisticServerId: 's1', optimisticChannelId: 'c2' })
    s.localState.userId = ''
    unload()
    expect(serverUsers.leaveVoiceChannelOnUnload).toHaveBeenCalledWith('s1', 'c2', 'me', 'token')
  })

  it('sends nothing for a DM call, a remote server\'s channel, or no call', () => {
    const s = store()
    Object.assign(s, { isConnected: true, currentServerId: 'dm', currentChannelId: 'dm-x' })
    unload()
    Object.assign(s, { isConnected: true, currentServerId: 's9', currentChannelId: 'c9', isFederatedChannel: true })
    unload()
    s.resetState()
    unload()
    expect(serverUsers.leaveVoiceChannelOnUnload).not.toHaveBeenCalled()
  })
})
