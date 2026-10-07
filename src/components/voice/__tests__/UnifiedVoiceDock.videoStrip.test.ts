import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import UnifiedVoiceDock from '../UnifiedVoiceDock.vue'

// Dock wiring: a strip tile opens the overlay focused on that feed, and the
// single thumbnail returns only while the strip is collapsed. Thumbnails
// release their element on every change and mirror only the self camera.

const h = vi.hoisted(() => ({ store: null as any, storage: new Map<string, string>() }))
// __esModule lets defineAsyncComponent unwrap the mocked module to its default.
const { stub } = vi.hoisted(() => ({ stub: (name: string) => ({ __esModule: true, default: { name, render: () => null } }) }))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => h.store }))
vi.mock('@/stores/spatialAudio', () => ({
  useSpatialAudioStore: () => ({ isPanelVisible: false, settings: { enabled: false }, togglePanel: vi.fn() }),
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'me' } } }) }))
vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({
    getUser: () => ({ value: null }),
    getUserAvatarUrl: () => ({ value: '/default_avatar.webp' }),
    getUserDisplayName: (id: string) => ({ value: id }),
  }),
}))
vi.mock('@/composables/useKeybinds', async () => {
  const { ref } = await import('vue')
  return { useKeybinds: () => ({ isPTTMode: ref(false), isPTTActive: ref(false), getKeybindDisplay: () => '' }) }
})
vi.mock('@/composables/useViewport', async () => {
  const { ref } = await import('vue')
  return { useViewport: () => ({ isMobileViewport: ref(false) }) }
})
vi.mock('@/utils/userScopedStorage', () => ({
  userStorage: {
    getItem: (key: string) => h.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { h.storage.set(key, value) },
    removeItem: (key: string) => { h.storage.delete(key) },
  },
}))
vi.mock('@/utils/platform', () => ({ isMobileUserAgent: () => false }))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/DisplayName.vue', () => stub('DisplayName'))
vi.mock('@/components/icons/Headphones.vue', () => stub('Headphones'))
vi.mock('../VoiceEncryptionBadge.vue', () => stub('VoiceEncryptionBadge'))
vi.mock('../PushToTalkButton.vue', () => stub('PushToTalkButton'))
vi.mock('../VoiceCallBanner.vue', () => stub('VoiceCallBanner'))
vi.mock('../StreamQualityPicker.vue', () => stub('StreamQualityPicker'))
vi.mock('../UnifiedVoiceOverlay.vue', () => stub('UnifiedVoiceOverlay'))
vi.mock('../VoiceSettingsPanel.vue', () => stub('VoiceSettingsPanel'))
vi.mock('../VoiceChannelParticipants.vue', () => stub('VoiceChannelParticipants'))
vi.mock('../SpatialAudioPanel.vue', () => stub('SpatialAudioPanel'))
vi.mock('../RecentSpeakers.vue', () => stub('RecentSpeakers'))
vi.mock('../ScreensharePIP.vue', () => stub('ScreensharePIP'))

const member = (userId: string, extra: Record<string, unknown> = {}) => ({
  userId, isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: false,
  isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0, ...extra,
})

function makeStore(remote: ReturnType<typeof member>[], local = member('me')) {
  const store = reactive({
    isConnectedOrJoining: true,
    isConnecting: false,
    isConnected: true,
    connectionState: 'connected',
    transportLabel: 'SFU',
    connectionMode: 'livekit',
    isEncrypted: false,
    dmOtherUserId: null,
    effectiveChannelName: 'General',
    callStartTime: null,
    connectionStats: { total: remote.length + 1, withVideo: 0, speaking: 0 },
    localState: local,
    allUsers: remote,
    get allParticipants() {
      return [this.localState, ...this.allUsers]
    },
    watchedStreamUserIds: [] as string[],
    viewMode: 'normal',
    fullscreenUserId: null as string | null,
    fullscreenSource: 'camera',
    pipActive: false,
    pipUserId: null as string | null,
    isOverlayVisible: false,
    streamUpdateCounter: 0,
    isWatchingStream(userId: string) {
      return userId === this.localState.userId || this.watchedStreamUserIds.includes(userId)
    },
    getUserStream: () => null,
    getConnectionQuality: () => 'good',
    attachVideoToElement: vi.fn((_userId: string, el: HTMLVideoElement) => {
      el.srcObject = new MediaStream()
      return true
    }),
    detachVideoFromElement: vi.fn(),
    watchStream: vi.fn(),
    togglePIP: vi.fn(),
    enterFullscreen: vi.fn((userId: string, source: 'camera' | 'screen') => {
      store.viewMode = 'fullscreen'
      store.fullscreenUserId = userId
      store.fullscreenSource = source
    }),
  })
  return store
}

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  h.storage.clear()
})

async function mountDock() {
  const dock = mount(UnifiedVoiceDock, { attachTo: document.body })
  await flushPromises()
  await nextTick()
  return dock
}

describe('UnifiedVoiceDock video strip', () => {
  it('opens the overlay focused on the clicked tile', async () => {
    h.store = makeStore([member('bob', { isVideoEnabled: true }), member('carol', { isScreenSharing: true })])
    wrapper = await mountDock()

    await wrapper.find('.dock-tile[data-user-id="bob"]').trigger('click')
    await flushPromises()

    expect(h.store.enterFullscreen).toHaveBeenCalledWith('bob', 'camera')
    expect(h.store.isOverlayVisible).toBe(true)
    expect(h.store.watchStream).not.toHaveBeenCalled()
    expect(wrapper.find('.dock-container').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'UnifiedVoiceOverlay' }).exists()).toBe(true)
  })

  it('shows the single thumbnail only while the strip is collapsed', async () => {
    h.store = makeStore([member('bob', { isVideoEnabled: true })])
    wrapper = await mountDock()

    expect(wrapper.find('.dock-video-strip').exists()).toBe(true)
    expect(wrapper.find('.dock-video-preview').exists()).toBe(false)
    // Mounted expanded: only the tile attaches, never the thumbnail.
    expect(h.store.attachVideoToElement.mock.calls.map((call: unknown[]) => [call[0], call[2]])).toEqual([['bob', 'camera']])
    expect(h.store.detachVideoFromElement).not.toHaveBeenCalled()

    await wrapper.find('.strip-collapse').trigger('click')
    await flushPromises()
    expect(wrapper.find('.dock-video-strip').exists()).toBe(false)
    expect(wrapper.find('.dock-video-preview').exists()).toBe(true)

    await wrapper.find('.strip-expand').trigger('click')
    await flushPromises()
    expect(wrapper.find('.dock-video-preview').exists()).toBe(false)
    // The thumbnail element is released, not left attached.
    expect(h.store.detachVideoFromElement).toHaveBeenCalledWith('bob', expect.anything(), 'camera')
  })

  it('keeps an audio-only dock unchanged', async () => {
    h.store = makeStore([member('bob')])
    wrapper = await mountDock()

    expect(wrapper.find('.dock-video-strip').exists()).toBe(false)
    expect(wrapper.find('.strip-expand').exists()).toBe(false)
    expect(wrapper.find('.dock-video-preview').exists()).toBe(false)
    expect(wrapper.find('.voice-controls').exists()).toBe(true)
  })

  it('releases the minimized thumbnail on user change, element change and unmount', async () => {
    h.store = makeStore([member('bob', { isVideoEnabled: true }), member('carol')])
    wrapper = await mountDock()
    await wrapper.find('.minimize-btn').trigger('click')
    await flushPromises()

    const mini = wrapper.find('.mini-video').element
    expect(h.store.attachVideoToElement).toHaveBeenLastCalledWith('bob', mini, 'camera')
    h.store.detachVideoFromElement.mockClear()

    // User change on the same element.
    h.store.allUsers.splice(0, 2, member('bob'), member('carol', { isVideoEnabled: true }))
    await flushPromises()
    expect(h.store.detachVideoFromElement).toHaveBeenCalledWith('bob', mini, 'camera')
    expect(h.store.attachVideoToElement).toHaveBeenLastCalledWith('carol', mini, 'camera')
    expect(wrapper.find('.mini-video').element).toBe(mini)

    // Source change for the same user re-attaches the other publication.
    h.store.allUsers.splice(1, 1, member('carol', { isVideoEnabled: true, isScreenSharing: true }))
    h.store.watchedStreamUserIds = ['carol']
    await flushPromises()
    expect(h.store.detachVideoFromElement).toHaveBeenLastCalledWith('carol', mini, 'camera')
    expect(h.store.attachVideoToElement).toHaveBeenLastCalledWith('carol', mini, 'screen')

    // Element change: back to the dock unmounts the minimized element.
    h.store.detachVideoFromElement.mockClear()
    await wrapper.find('.minimized-container').trigger('click')
    await flushPromises()
    expect(wrapper.find('.mini-video').exists()).toBe(false)
    expect(h.store.detachVideoFromElement).toHaveBeenCalledWith('carol', mini, 'screen')

    // Unmount releases whichever thumbnail is attached.
    await wrapper.find('.minimize-btn').trigger('click')
    await flushPromises()
    const second = wrapper.find('.mini-video').element
    h.store.detachVideoFromElement.mockClear()
    wrapper.unmount()
    wrapper = null
    expect(h.store.detachVideoFromElement).toHaveBeenCalledWith('carol', second, 'screen')
  })

  it('does not re-attach a thumbnail that still holds its stream', async () => {
    h.store = makeStore([member('bob', { isVideoEnabled: true })])
    wrapper = await mountDock()
    await wrapper.find('.minimize-btn').trigger('click')
    await flushPromises()
    const calls = h.store.attachVideoToElement.mock.calls.length

    h.store.allUsers.splice(0, 1, member('bob', { isVideoEnabled: true, audioLevel: 40 }))
    h.store.streamUpdateCounter++
    await flushPromises()
    expect(h.store.attachVideoToElement.mock.calls.length).toBe(calls)

    ;(wrapper.find('.mini-video').element as HTMLVideoElement).srcObject = null
    h.store.streamUpdateCounter++
    await flushPromises()
    expect(h.store.attachVideoToElement.mock.calls.length).toBe(calls + 1)
  })

  it('mirrors the self camera in both thumbnails and nothing else', async () => {
    h.store = makeStore([], member('me', { isVideoEnabled: true }))
    h.storage.set('voice-dock-video-strip-collapsed', '1')
    wrapper = await mountDock()

    expect(wrapper.find('.dock-video').classes()).toContain('mirrored')
    expect(h.store.attachVideoToElement).toHaveBeenLastCalledWith('me', expect.anything(), 'camera')
    await wrapper.find('.minimize-btn').trigger('click')
    await flushPromises()
    expect(wrapper.find('.mini-video').classes()).toContain('mirrored')

    // Own screen share outranks own camera and is never mirrored.
    h.store.localState = member('me', { isVideoEnabled: true, isScreenSharing: true })
    await flushPromises()
    expect(wrapper.find('.mini-video').classes()).not.toContain('mirrored')
    expect(h.store.attachVideoToElement).toHaveBeenLastCalledWith('me', expect.anything(), 'screen')

    // A remote camera outranks own video and is never mirrored.
    h.store.allUsers.push(member('bob', { isVideoEnabled: true }))
    await flushPromises()
    expect(wrapper.find('.mini-video').classes()).not.toContain('mirrored')
    expect(h.store.attachVideoToElement).toHaveBeenLastCalledWith('bob', expect.anything(), 'camera')
  })
})
