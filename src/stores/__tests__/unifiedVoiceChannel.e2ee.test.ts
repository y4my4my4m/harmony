import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Whether a join asks the transport for end-to-end encryption: a voice channel follows its
// effective voice encryption, a local DM call its conversation's encryption, and a token join
// (the callee side of a federated DM call) never encrypts. A device that cannot encrypt is
// refused an encrypted call with the key setup or unlock prompt, before voice presence.

const handlers = vi.hoisted(() => ({} as Record<string, (payload: any) => unknown>))
const webrtc = vi.hoisted(() => ({
  on: (event: string, cb: (payload: any) => unknown) => { handlers[event] = cb },
  joinChannel: vi.fn(async (..._args: unknown[]) => false),
  joinWithToken: vi.fn(async (..._args: unknown[]) => false),
  getAllUsers: vi.fn(() => [] as any[]),
  getActiveService: vi.fn(() => 'livekit'),
  getLastJoinError: vi.fn(() => 'transport stub' as string | null),
  isE2EEEnabled: vi.fn(() => false),
  getLocalState: vi.fn(() => ({ userId: 'me' })),
  getLocalStream: vi.fn(() => null),
  leaveChannel: vi.fn(async () => undefined),
  preloadTransport: vi.fn(),
  setAutoWatchStreams: vi.fn(),
  setMasterVolume: vi.fn(),
}))
const serverUsers = vi.hoisted(() => ({
  getUsersInVoiceChannel: vi.fn(() => [] as string[]),
  joinVoiceChannel: vi.fn(async () => true),
  leaveVoiceChannel: vi.fn(async () => true),
  markVoiceTransport: vi.fn(async () => undefined),
  getCallStartTime: vi.fn(() => null),
}))
const effective = vi.hoisted(() => vi.fn(async (_id: string) => null as any))
const conversation = vi.hoisted(() => vi.fn(async (_id: string) => false))
const voiceE2EE = vi.hoisted(() => ({
  canParticipate: vi.fn(() => true),
  participationBlocker: vi.fn(async () => null as 'setup' | 'unlock' | null),
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
vi.mock('@/services/voice/voiceAnnouncements', () => ({
  voiceAnnouncer: new Proxy({}, { get: () => () => undefined }),
}))
vi.mock('@/composables/useKeybinds', () => ({ useKeybinds: () => ({}) }))
vi.mock('@/services/encryption/VoiceE2EEService', () => ({ voiceE2EEService: voiceE2EE }))
vi.mock('@/services/ChannelEncryptionService', () => ({ fetchEffectiveChannelEncryption: effective }))
vi.mock('@/services/conversationEncryption', () => ({ fetchConversationEncryption: conversation }))
vi.mock('@/utils/userScopedStorage', () => ({ userStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() } }))
vi.mock('@/i18n', async () => {
  const { createI18n } = await import('vue-i18n')
  const en = (await import('@/locales/en.json')).default
  return { i18n: createI18n({ legacy: false, locale: 'en', messages: { en } }) }
})

import { ENCRYPTION_ACTION_EVENT } from '@/composables/useEncryptionAction'

const CONVERSATION = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const CHANNEL = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
const DM_ROOM = `dm-${CONVERSATION}`

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

const actions: CustomEvent[] = []
const onAction = (event: Event) => { actions.push(event as CustomEvent) }

beforeEach(() => {
  setActivePinia(createPinia())
  for (const k of Object.keys(handlers)) delete handlers[k]
  webrtc.joinChannel.mockClear()
  webrtc.joinWithToken.mockClear()
  serverUsers.joinVoiceChannel.mockClear()
  effective.mockReset().mockResolvedValue(null)
  conversation.mockReset().mockResolvedValue(false)
  voiceE2EE.canParticipate.mockReset().mockReturnValue(true)
  voiceE2EE.participationBlocker.mockReset().mockResolvedValue(null)
  actions.length = 0
  window.addEventListener(ENCRYPTION_ACTION_EVENT, onAction)
})

afterEach(() => {
  window.removeEventListener(ENCRYPTION_ACTION_EVENT, onAction)
})

describe('resolveVoiceE2EERequired', () => {
  it("follows a voice channel's effective voice encryption", async () => {
    const s = await store()
    effective.mockResolvedValueOnce({ voiceEncrypted: true })
    await expect(s.resolveVoiceE2EERequired('server', CHANNEL)).resolves.toBe(true)
    effective.mockResolvedValueOnce({ voiceEncrypted: false })
    await expect(s.resolveVoiceE2EERequired('server', CHANNEL)).resolves.toBe(false)
    effective.mockRejectedValueOnce(new Error('offline'))
    await expect(s.resolveVoiceE2EERequired('server', CHANNEL)).resolves.toBe(false)
  })

  it("follows a local DM call's conversation encryption", async () => {
    const s = await store()
    conversation.mockResolvedValueOnce(true)
    await expect(s.resolveVoiceE2EERequired('dm', DM_ROOM)).resolves.toBe(true)
    expect(conversation).toHaveBeenLastCalledWith(CONVERSATION)
    conversation.mockResolvedValueOnce(false)
    await expect(s.resolveVoiceE2EERequired('dm', DM_ROOM)).resolves.toBe(false)
    expect(effective).not.toHaveBeenCalled()
  })

  it('answers false for a federated DM call room', async () => {
    const s = await store()
    conversation.mockResolvedValue(true)
    await expect(s.resolveVoiceE2EERequired('dm', `federated-dm-${CONVERSATION}`)).resolves.toBe(false)
    expect(conversation).not.toHaveBeenCalled()
  })
})

describe('joining an encrypted call', () => {
  it('asks the transport for E2EE in a DM call of an encrypted conversation', async () => {
    const s = await store()
    conversation.mockResolvedValue(true)
    await s.joinVoiceChannel(DM_ROOM, 'dm')
    expect(webrtc.joinChannel).toHaveBeenCalledWith(DM_ROOM, 'me', 'dm_call', expect.anything(), true)
  })

  it('asks for no E2EE in a DM call of a plaintext conversation', async () => {
    const s = await store()
    conversation.mockResolvedValue(false)
    await s.joinVoiceChannel(DM_ROOM, 'dm')
    expect(webrtc.joinChannel).toHaveBeenCalledWith(DM_ROOM, 'me', 'dm_call', expect.anything(), false)
  })

  it('asks for E2EE in an encrypted voice channel', async () => {
    const s = await store()
    effective.mockResolvedValue({ voiceEncrypted: true })
    await s.joinVoiceChannel(CHANNEL, 'server')
    expect(webrtc.joinChannel).toHaveBeenCalledWith(CHANNEL, 'me', 'voice_channel', expect.anything(), true)
  })

  it('joins a federated DM call by token without reading the conversation', async () => {
    const s = await store()
    conversation.mockResolvedValue(true)
    await s.joinVoiceChannel(`federated-dm-${CONVERSATION}`, 'dm', { livekit: { wsUrl: 'wss://lk.remote.example', token: 't' } })
    expect(conversation).not.toHaveBeenCalled()
    expect(webrtc.joinWithToken).toHaveBeenCalled()
    expect(webrtc.joinChannel).not.toHaveBeenCalled()
  })

  it('refuses a device without keys and opens the setup prompt', async () => {
    const s = await store()
    effective.mockResolvedValue({ voiceEncrypted: true })
    voiceE2EE.canParticipate.mockReturnValue(false)
    voiceE2EE.participationBlocker.mockResolvedValue('setup')

    await expect(s.joinVoiceChannel(CHANNEL, 'server')).resolves.toBe(false)
    expect(webrtc.joinChannel).not.toHaveBeenCalled()
    expect(serverUsers.joinVoiceChannel).not.toHaveBeenCalled()
    expect(s.joinError).toBe('This voice channel is end-to-end encrypted. Set up encryption to join.')
    expect(actions.map((e) => e.detail)).toEqual([{ reason: 'setup', message: s.joinError, toast: false }])
    expect(s.isConnecting).toBe(false)
  })

  it('refuses a DM call while keys are locked and opens the unlock prompt', async () => {
    const s = await store()
    conversation.mockResolvedValue(true)
    voiceE2EE.canParticipate.mockReturnValue(false)
    voiceE2EE.participationBlocker.mockResolvedValue('unlock')

    await expect(s.joinVoiceChannel(DM_ROOM, 'dm')).resolves.toBe(false)
    expect(webrtc.joinChannel).not.toHaveBeenCalled()
    expect(s.joinError).toMatch(/^Calls in this conversation are end-to-end encrypted\. Unlock encryption/)
    expect(actions.map((e) => e.detail.reason)).toEqual(['unlock'])
  })

  it('joins once keys unlock while the gate waits', async () => {
    const s = await store()
    effective.mockResolvedValue({ voiceEncrypted: true })
    voiceE2EE.canParticipate.mockReturnValue(false)
    voiceE2EE.participationBlocker.mockResolvedValue(null)

    await s.joinVoiceChannel(CHANNEL, 'server')
    expect(webrtc.joinChannel).toHaveBeenCalledWith(CHANNEL, 'me', 'voice_channel', expect.anything(), true)
    expect(actions).toHaveLength(0)
  })
})
