import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Spatial audio holds a call's layout: where each participant sits, the panel, a drag. Leaving
// the channel or signing out (clearVoiceChannelState) ends it, and the enabled choice is the
// signed-in user's.

const stored = vi.hoisted(() => new Map<string, string>())

vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/services/UserEventChannel', () => ({ userEventChannel: { on: () => () => {} } }))
vi.mock('@/services/instanceConfig', () => ({ apiUrl: (p: string) => p }))
vi.mock('@/services/webrtcManager', () => ({ webrtcManager: { on: vi.fn() } }))
vi.mock('@/services/voice/remoteAudioMixer', () => ({
  clampVolume: (v: number) => v,
  remoteAudioMixer: { onBlockedChange: vi.fn() },
}))
vi.mock('@/services/voice/voiceAudioPrefs', () => ({ loadAudioPrefs: () => ({}), saveMutes: vi.fn(), saveVolumes: vi.fn() }))
vi.mock('@/services/voice/voiceAudioContext', () => ({ closeVoiceAudioContext: vi.fn() }))
vi.mock('@/services/VoiceSettingsService', () => ({ VoiceSettingsService: {}, normalizeOutputVolume: (v: number) => v }))
vi.mock('@/services/spatialAudio', () => ({ spatialAudioService: {} }))
vi.mock('@/services/DMCallSignaling', () => ({ dmCallSignaling: {} }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({}) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: null }) }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => ({}) }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ channels: [] }) }))
vi.mock('@/services/callForegroundService', () => ({ setCallServiceActive: vi.fn() }))
vi.mock('@/services/overlayBridge', () => ({ syncOverlayForCall: vi.fn() }))
vi.mock('@/stores/useTheme', () => ({ useThemeStore: () => ({ playAudio: vi.fn() }) }))
vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => ({ showToast: vi.fn() }) }))
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

import { useSpatialAudioStore } from '@/stores/spatialAudio'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'

function laidOut() {
  const spatial = useSpatialAudioStore()
  spatial.setUserPosition('peer-1', 40, 80)
  spatial.setUserPosition('peer-2', 300, 120)
  spatial.showPanel()
  spatial.startDrag('peer-1', 40, 80)
  return spatial
}

describe('spatial audio layout', () => {
  beforeEach(() => {
    stored.clear()
    setActivePinia(createPinia())
  })

  it('reset ends the layout and reads the enabled choice again', () => {
    const spatial = laidOut()
    spatial.settings.enabled = true

    spatial.reset()

    expect(spatial.userPositions.size).toBe(0)
    expect(spatial.isPanelVisible).toBe(false)
    expect(spatial.isDragging).toBe(false)
    expect(spatial.draggedUserId).toBeNull()
    expect(spatial.settings.enabled).toBe(false)
  })

  it('clearing the voice channel state (leave, sign-out) ends the layout', () => {
    const spatial = laidOut()

    useUnifiedVoiceChannelStore().clearVoiceChannelState()

    expect(spatial.userPositions.size).toBe(0)
    expect(spatial.isPanelVisible).toBe(false)
  })

  it("a join applies the joining user's stored choice, not the one in memory", async () => {
    const spatial = useSpatialAudioStore()
    spatial.settings.enabled = true
    stored.set('spatial-audio-enabled', 'false')

    await useUnifiedVoiceChannelStore().initializeSpatialAudio('me')

    expect(spatial.settings.enabled).toBe(false)
  })
})
