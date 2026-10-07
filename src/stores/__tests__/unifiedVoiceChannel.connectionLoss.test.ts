import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// A voice link that stays in 'reconnecting' is dropped with a toast after
// VOICE_RECONNECT_GIVE_UP_MS; a join whose microphone never opens says so.

const handlers = vi.hoisted(() => ({} as Record<string, (payload: any) => unknown>))
const webrtc = vi.hoisted(() => ({
  on: (event: string, cb: (payload: any) => unknown) => { handlers[event] = cb },
  leaveChannel: vi.fn(async () => undefined),
}))
const toast = vi.hoisted(() => vi.fn())

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
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({}) }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => ({}) }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ channels: [] }) }))
vi.mock('@/services/callForegroundService', () => ({ setCallServiceActive: vi.fn() }))
vi.mock('@/services/overlayBridge', () => ({ syncOverlayForCall: vi.fn() }))
vi.mock('@/stores/useTheme', () => ({ useThemeStore: () => ({}) }))
vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => ({ showToast: toast }) }))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({}) }))
vi.mock('@/composables/useKeybinds', () => ({ useKeybinds: () => ({}) }))
vi.mock('@/services/encryption/VoiceE2EEService', () => ({ voiceE2EEService: {} }))
vi.mock('@/services/ChannelEncryptionService', () => ({ fetchEffectiveChannelEncryption: vi.fn() }))
vi.mock('@/utils/userScopedStorage', () => ({ userStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() } }))

import { useUnifiedVoiceChannelStore, VOICE_RECONNECT_GIVE_UP_MS } from '@/stores/unifiedVoiceChannel'

// The listeners register once per module and bind the store they were
// registered on, so every test shares one Pinia and one store.
function connectedStore() {
  const s = useUnifiedVoiceChannelStore() as any
  s.resetState()
  s.leaveVoiceChannel = vi.fn(async () => {
    s.resetState()
    return true
  })
  s.setupWebRTCListeners()
  s.isConnected = true
  s.currentChannelId = 'c1'
  s.connectionState = 'connected'
  return s
}

const emit = (event: string, payload?: any) => handlers[event]?.(payload)

beforeAll(() => {
  setActivePinia(createPinia())
})

beforeEach(() => {
  vi.useFakeTimers()
  toast.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('voice connection loss', () => {
  it('leaves with a toast when reconnecting outlasts the give-up window', async () => {
    const s = connectedStore()
    emit('connection-state-changed', { state: 'reconnecting' })
    expect(s.connectionState).toBe('reconnecting')

    await vi.advanceTimersByTimeAsync(VOICE_RECONNECT_GIVE_UP_MS - 1)
    expect(s.leaveVoiceChannel).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(s.leaveVoiceChannel).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith('server_update', 'Disconnected from voice', expect.any(String), 6000)
    expect(s.connectionState).toBeNull()
  })

  it('keeps the session when the link comes back in time', async () => {
    const s = connectedStore()
    emit('connection-state-changed', { state: 'signalReconnecting' })
    await vi.advanceTimersByTimeAsync(VOICE_RECONNECT_GIVE_UP_MS / 2)
    emit('connection-state-changed', { state: 'connected' })
    await vi.advanceTimersByTimeAsync(VOICE_RECONNECT_GIVE_UP_MS)
    expect(s.leaveVoiceChannel).not.toHaveBeenCalled()
    expect(s.connectionState).toBe('connected')
  })

  it('measures the window from the first reconnecting event', async () => {
    const s = connectedStore()
    emit('connection-state-changed', { state: 'reconnecting' })
    await vi.advanceTimersByTimeAsync(VOICE_RECONNECT_GIVE_UP_MS / 2)
    emit('connection-state-changed', { state: 'signalReconnecting' })
    await vi.advanceTimersByTimeAsync(VOICE_RECONNECT_GIVE_UP_MS / 2)
    expect(s.leaveVoiceChannel).toHaveBeenCalledTimes(1)
  })

  it('drops the pending give-up when the transport reports the loss itself', async () => {
    const s = connectedStore()
    emit('connection-state-changed', { state: 'reconnecting' })
    await emit('connection-lost')
    expect(s.leaveVoiceChannel).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(VOICE_RECONNECT_GIVE_UP_MS)
    expect(s.leaveVoiceChannel).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it('tells the user when the microphone could not be opened', () => {
    connectedStore()
    emit('microphone-unavailable', { error: new Error('Microphone acquisition timed out') })
    expect(toast).toHaveBeenCalledWith('server_update', 'Microphone unavailable', expect.any(String), 6000)
  })
})
