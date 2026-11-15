import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// A voice link that stays in 'reconnecting' is dropped with a toast after
// VOICE_RECONNECT_GIVE_UP_MS; a join whose microphone never opens says so. A session last
// seen connected over VOICE_REJOIN_MAX_AGE_MS ago is not resumed, on app start or after the
// machine slept; a P2P session stamps its row every VOICE_P2P_TOUCH_MS.

const handlers = vi.hoisted(() => ({} as Record<string, (payload: any) => unknown>))
const webrtc = vi.hoisted(() => ({
  on: (event: string, cb: (payload: any) => unknown) => { handlers[event] = cb },
  leaveChannel: vi.fn(async () => undefined),
}))
const toast = vi.hoisted(() => vi.fn())
const stored = vi.hoisted(() => new Map<string, string>())
const serverUsers = vi.hoisted(() => ({ touchVoiceParticipant: vi.fn(async () => undefined) }))

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
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: null }) }))
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

import {
  useUnifiedVoiceChannelStore,
  VOICE_P2P_TOUCH_MS,
  VOICE_RECONNECT_GIVE_UP_MS,
  VOICE_REJOIN_MAX_AGE_MS,
} from '@/stores/unifiedVoiceChannel'

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
  stored.clear()
  serverUsers.touchVoiceParticipant.mockClear()
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

describe('voice rejoin age', () => {
  const MINUTE = 60_000

  // A session joined five hours ago whose heartbeat last ran `lastSeenAgo` ms ago.
  function savedSession(lastSeenAgo: number) {
    const now = Date.now()
    stored.set('voiceChannelState', JSON.stringify({ channelId: 'c1', serverId: 's1', channelName: 'lounge', timestamp: now - 5 * 60 * MINUTE }))
    stored.set('active-voice-session', JSON.stringify({ tabId: 'tab-old', channelId: 'c1', timestamp: now - lastSeenAgo }))
  }

  function idleStore() {
    const s = useUnifiedVoiceChannelStore() as any
    s.resetState()
    s.joinVoiceChannel = vi.fn(async () => true)
    return s
  }

  it('does not rejoin a session last seen connected 3 h 01 min ago, and forgets it', async () => {
    const s = idleStore()
    savedSession(VOICE_REJOIN_MAX_AGE_MS + MINUTE)
    await expect(s.reconnectToVoiceChannel()).resolves.toBe(false)
    expect(s.joinVoiceChannel).not.toHaveBeenCalled()
    expect(stored.has('voiceChannelState')).toBe(false)
    expect(stored.has('active-voice-session')).toBe(false)
  })

  it('rejoins a session last seen connected 2 h 59 min ago, though joined five hours ago', async () => {
    const s = idleStore()
    savedSession(VOICE_REJOIN_MAX_AGE_MS - MINUTE)
    await expect(s.reconnectToVoiceChannel()).resolves.toBe(true)
    expect(s.joinVoiceChannel).toHaveBeenCalledWith('c1', 's1')
  })

  it('judges by the join time when the session marker names another channel', async () => {
    const s = idleStore()
    savedSession(MINUTE)
    stored.set('active-voice-session', JSON.stringify({ tabId: 'tab-old', channelId: 'c2', timestamp: Date.now() }))
    await expect(s.reconnectToVoiceChannel()).resolves.toBe(false)
    expect(s.joinVoiceChannel).not.toHaveBeenCalled()
  })

  it('leaves when the session heartbeat resumes after a 3 h gap', async () => {
    const s = connectedStore()
    s.startVoiceSessionHeartbeat()
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(s.leaveVoiceChannel).not.toHaveBeenCalled()

    // The machine sleeps: the clock moves, no timer runs.
    vi.setSystemTime(Date.now() + VOICE_REJOIN_MAX_AGE_MS)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(s.leaveVoiceChannel).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith('server_update', 'Disconnected from voice', expect.any(String), 6000)
    s.stopVoiceSessionHeartbeat()
  })

  it('keeps a session whose heartbeat ran throughout', async () => {
    const s = connectedStore()
    s.startVoiceSessionHeartbeat()
    await vi.advanceTimersByTimeAsync(VOICE_REJOIN_MAX_AGE_MS + 2_000)
    expect(s.leaveVoiceChannel).not.toHaveBeenCalled()
    s.stopVoiceSessionHeartbeat()
  })
})

describe('P2P liveness', () => {
  it('stamps a P2P session row every minute, and no LiveKit one', async () => {
    const s = connectedStore()
    s.currentServerId = 's1'
    s.localState = { ...s.localState, userId: 'me' }
    s.connectionMode = 'p2p'
    s.startVoiceSessionHeartbeat()
    await vi.advanceTimersByTimeAsync(VOICE_P2P_TOUCH_MS * 3)
    expect(serverUsers.touchVoiceParticipant).toHaveBeenCalledTimes(3)
    expect(serverUsers.touchVoiceParticipant).toHaveBeenCalledWith('s1', 'c1', 'me')

    serverUsers.touchVoiceParticipant.mockClear()
    s.connectionMode = 'livekit'
    await vi.advanceTimersByTimeAsync(VOICE_P2P_TOUCH_MS * 3)
    expect(serverUsers.touchVoiceParticipant).not.toHaveBeenCalled()
    s.stopVoiceSessionHeartbeat()
  })
})
