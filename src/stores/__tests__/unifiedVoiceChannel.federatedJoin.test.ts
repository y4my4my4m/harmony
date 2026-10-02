import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// joinFederatedVoiceChannel takes the remote server's answer from the private
// user channel, and only the answer naming its own join id and server host.

const handlers = vi.hoisted(() => ({} as Record<string, (payload: any) => unknown>))
const userEvents = vi.hoisted(() => ({
  on: (type: string, cb: (payload: any) => unknown) => {
    handlers[type] = cb
    return () => { if (handlers[type] === cb) delete handlers[type] }
  },
}))
const webrtc = vi.hoisted(() => ({
  joinWithToken: vi.fn(async () => true),
  getActiveService: vi.fn(() => 'livekit'),
  isE2EEEnabled: vi.fn(() => false),
  getLocalState: vi.fn(() => ({})),
  getLocalStream: vi.fn(() => null),
  leaveChannel: vi.fn(async () => undefined),
}))
const serverUsers = vi.hoisted(() => ({ joinVoiceChannel: vi.fn(), leaveVoiceChannel: vi.fn() }))

vi.mock('@/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
  },
}))
vi.mock('@/services/UserEventChannel', () => ({ userEventChannel: userEvents }))
vi.mock('@/services/instanceConfig', () => ({ apiUrl: (p: string) => p }))
vi.mock('@/services/webrtcManager', () => ({ webrtcManager: webrtc }))
vi.mock('@/services/nativeLiveKit', () => ({ nativeLiveKit: {} }))
vi.mock('@/services/voice/remoteAudioMixer', () => ({ clampVolume: (v: number) => v, remoteAudioMixer: {} }))
vi.mock('@/services/voice/voiceAudioPrefs', () => ({ loadAudioPrefs: () => ({}), saveMutes: vi.fn(), saveVolumes: vi.fn() }))
vi.mock('@/services/voice/voiceAudioContext', () => ({ closeVoiceAudioContext: vi.fn() }))
vi.mock('@/services/VoiceSettingsService', () => ({ VoiceSettingsService: {}, normalizeOutputVolume: (v: number) => v }))
vi.mock('@/services/spatialAudio', () => ({ spatialAudioService: {} }))
vi.mock('@/services/DMCallSignaling', () => ({ dmCallSignaling: {} }))
vi.mock('@/stores/spatialAudio', () => ({ useSpatialAudioStore: () => ({}) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({}) }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => serverUsers }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ channels: [] }) }))
vi.mock('@/services/callForegroundService', () => ({ setCallServiceActive: vi.fn() }))
vi.mock('@/services/overlayBridge', () => ({ syncOverlayForCall: vi.fn() }))
vi.mock('@/stores/useTheme', () => ({ useThemeStore: () => ({}) }))
vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => ({}) }))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({}) }))
vi.mock('@/composables/useKeybinds', () => ({ useKeybinds: () => ({}) }))
vi.mock('@/services/encryption/VoiceE2EEService', () => ({ voiceE2EEService: {} }))
vi.mock('@/services/ChannelEncryptionService', () => ({ fetchEffectiveChannelEncryption: vi.fn() }))
vi.mock('@/utils/userScopedStorage', () => ({ userStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() } }))

import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'

const JOIN = 'https://harmony.test/users/me/activities/voice-join/n.1.mac'
const HOST = 'remote.test'
const legit = { originalJoinId: JOIN, serverHost: HOST, livekitUrl: 'wss://livekit.remote.test', token: 'GOOD' }

let releaseJoin: () => void

function store() {
  const s = useUnifiedVoiceChannelStore() as any
  for (const action of ['setupWebRTCListeners', 'syncTransmitGate', 'applyAudioPrefs',
    'saveVoiceChannelState', 'startVoiceSessionHeartbeat', 'setupPushToTalk']) {
    s[action] = vi.fn()
  }
  return s
}

const broadcast = (event: string, payload: any) => handlers[event]?.(payload)
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  setActivePinia(createPinia())
  for (const k of Object.keys(handlers)) delete handlers[k]
  webrtc.joinWithToken.mockClear()
  vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
    releaseJoin = () => resolve(new Response(JSON.stringify({ success: true, joinId: JOIN, serverHost: HOST }), { status: 200 }))
  })))
})

describe('joinFederatedVoiceChannel', () => {
  it('ignores tokens that do not answer the pending join, then takes the one that does', async () => {
    const s = store()
    const joined = s.joinFederatedVoiceChannel('chan', 'server', 'me')
    await flush()
    releaseJoin()
    await flush()
    await flush()

    await broadcast('federated_voice:token', { ...legit, originalJoinId: 'https://evil.test/x', token: 'EVIL' })
    await broadcast('federated_voice:token', { ...legit, serverHost: 'evil.test', livekitUrl: 'wss://livekit.evil.test', token: 'EVIL' })
    expect(webrtc.joinWithToken).not.toHaveBeenCalled()

    await broadcast('federated_voice:token', legit)
    await expect(joined).resolves.toBe(true)
    expect(webrtc.joinWithToken).toHaveBeenCalledWith('wss://livekit.remote.test', 'GOOD', 'chan', 'me')
  })

  it('holds a token that arrives before the join id is known and applies it only if it matches', async () => {
    const s = store()
    const joined = s.joinFederatedVoiceChannel('chan', 'server', 'me')
    await flush()

    await broadcast('federated_voice:token', { ...legit, token: 'EARLY-FORGED', originalJoinId: 'other' })
    await broadcast('federated_voice:token', legit)
    expect(webrtc.joinWithToken).not.toHaveBeenCalled()

    releaseJoin()
    await expect(joined).resolves.toBe(true)
    expect(webrtc.joinWithToken).toHaveBeenCalledTimes(1)
    expect(webrtc.joinWithToken).toHaveBeenCalledWith('wss://livekit.remote.test', 'GOOD', 'chan', 'me')
  })

  it('ignores a rejection that does not answer the pending join', async () => {
    const s = store()
    const joined = s.joinFederatedVoiceChannel('chan', 'server', 'me')
    await flush()
    releaseJoin()
    await flush()
    await flush()

    broadcast('federated_voice:rejected', { originalJoinId: 'https://evil.test/x', serverHost: HOST, reason: 'nope' })
    await broadcast('federated_voice:token', legit)
    await expect(joined).resolves.toBe(true)
  })
})
