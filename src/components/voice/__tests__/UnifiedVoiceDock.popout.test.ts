import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import UnifiedVoiceDock from '../UnifiedVoiceDock.vue'
import { closeCallPopout, focusCallPopout, openCallPopout } from '../callPopout'

// The dock's side of the call pop-out: Pop out among its controls; while the
// call view is in its own window, the main window keeps the minimized dock
// with Show and Return; the view comes back expanded when the window closes,
// and the window goes with the call.

const h = vi.hoisted(() => ({ store: null as any, popout: null as any, storage: new Map<string, string>() }))
// __esModule lets defineAsyncComponent unwrap the mocked module to its default.
const { stub } = vi.hoisted(() => ({ stub: (name: string) => ({ __esModule: true, default: { name, render: () => null } }) }))

vi.mock('@/stores/activities', () => ({
  useActivitiesStore: () => ({ current: null, playingHere: false, launcherOpen: false, launcherAnchor: null }),
}))
vi.mock('@/components/activities/useActivityButton', () => ({
  useActivityButton: () => ({
    available: { value: false }, visible: { value: false }, running: { value: false },
    anchor: { value: null }, toggle: () => {}, close: () => {},
  }),
}))
vi.mock('@/components/activities/ActivityLauncher.vue', () => ({ default: { name: 'ActivityLauncher', render: () => null } }))
vi.mock('@/components/activities/ActivityDockCard.vue', () => ({ default: { name: 'ActivityDockCard', render: () => null } }))
vi.mock('@/components/activities/ActivityStage.vue', () => ({ default: { name: 'ActivityStage', render: () => null } }))
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
  return {
    useKeybinds: () => ({
      isPTTMode: ref(false),
      isPTTActive: ref(false),
      getKeybindDisplay: () => '',
      getKeybind: () => ({ enabled: true }),
    }),
  }
})
vi.mock('@/composables/useViewport', async () => {
  const { ref } = await import('vue')
  return { useViewport: () => ({ isMobileViewport: ref(false), viewportHeight: ref(900) }) }
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
vi.mock('../LiveReactionLayer.vue', () => stub('LiveReactionLayer'))
vi.mock('../LiveReactionPopover.vue', () => ({
  __esModule: true,
  default: { name: 'LiveReactionPopover', props: ['visible', 'anchor', 'target'], emits: ['close'], render: () => null },
}))
vi.mock('../callPopout', async () => {
  const { computed, reactive } = await import('vue')
  h.popout = reactive({ active: false })
  return {
    callPopoutActive: computed(() => h.popout.active),
    callPopoutSupported: () => true,
    openCallPopout: vi.fn(async () => { h.popout.active = true; return true }),
    closeCallPopout: vi.fn(() => { h.popout.active = false }),
    focusCallPopout: vi.fn(),
  }
})
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn() }) }))
vi.mock('../SoundboardActivity.vue', () => stub('SoundboardActivity'))
vi.mock('../SoundboardPopover.vue', () => stub('SoundboardPopover'))
vi.mock('../useSoundboardButton', async () => {
  const { ref } = await import('vue')
  return { useSoundboardButton: () => ({ available: ref(false), visible: ref(false), anchor: ref(null), toggle: vi.fn(), close: vi.fn() }) }
})

const member = (userId: string, extra: Record<string, unknown> = {}) => ({
  userId, isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: false,
  isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0, ...extra,
})

function makeStore(remote: ReturnType<typeof member>[], local = member('me')) {
  const store = reactive({
    isConnectedOrJoining: true,
    canStream: true,
    speakLocked: false,
    deafenLocked: false,
    speakLockReason: null as string | null,
    isConnecting: false,
    isConnected: true,
    connectionState: 'connected',
    transportLabel: 'SFU',
    connectionMode: 'livekit',
    liveReactionsAvailable: false,
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
    currentChannelId: 'c1',
    toggleMute: vi.fn(() => { store.localState.isMuted = !store.localState.isMuted }),
    toggleDeafen: vi.fn(() => { store.localState.isDeafened = !store.localState.isDeafened }),
    toggleVideo: vi.fn(),
    leaveVoiceChannel: vi.fn(async () => true),
  })
  return store
}

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  h.storage.clear()
  h.popout.active = false
  vi.mocked(openCallPopout).mockClear()
  vi.mocked(closeCallPopout).mockClear()
  vi.mocked(focusCallPopout).mockClear()
})

async function mountDock() {
  const dock = mount(UnifiedVoiceDock, { attachTo: document.body })
  await flushPromises()
  await nextTick()
  return dock
}

const button = (w: VueWrapper, testid: string) => w.find(`[data-testid="${testid}"]`)

describe('UnifiedVoiceDock pop-out', () => {
  it('offers Pop out among the dock controls, titled by the channel', async () => {
    h.store = makeStore([member('bob')])
    wrapper = await mountDock()
    const popOut = button(wrapper, 'dock-popout')
    expect(popOut.attributes('aria-label')).toBe('voice.popout.open')
    await popOut.trigger('click')
    await flushPromises()
    expect(openCallPopout).toHaveBeenCalledWith({ title: 'voice.popout.windowTitle' })
  })

  it('popped out, keeps the call view mounted and a minimized dock with Return and Show in place of Expand', async () => {
    h.store = makeStore([member('bob')])
    wrapper = await mountDock()
    h.popout.active = true
    await flushPromises()
    expect(wrapper.find('.minimized-container').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'UnifiedVoiceOverlay' }).exists()).toBe(true)
    expect(wrapper.find('[data-testid="mini-expand"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mini-float"]').exists()).toBe(false)
    const order = wrapper.findAll('.minimized-controls > button').map((b) => b.attributes('data-testid') ?? b.classes().join(' '))
    expect(order).toEqual(['mini-popout-return', 'mini-popout-focus', 'mini-control-btn leave'])

    const show = button(wrapper, 'mini-popout-focus')
    expect(show.attributes('aria-label')).toBe('voice.popout.focus')
    await show.trigger('click')
    expect(focusCallPopout).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.minimized-container').exists()).toBe(true)

    // Asking for the call view while it is popped out leaves the dock as it is.
    h.store.isOverlayVisible = true
    await flushPromises()
    expect(wrapper.find('.minimized-container').exists()).toBe(true)

    const back = button(wrapper, 'mini-popout-return')
    expect(back.attributes('aria-label')).toBe('voice.popout.return')
    await back.trigger('click')
    await flushPromises()
    expect(closeCallPopout).toHaveBeenCalledTimes(1)
  })

  it('brings the call view back expanded when the pop-out closes', async () => {
    h.store = makeStore([member('bob')])
    wrapper = await mountDock()
    h.popout.active = true
    await flushPromises()
    h.popout.active = false
    await flushPromises()
    expect(h.store.isOverlayVisible).toBe(true)
    expect(wrapper.find('.minimized-container').exists()).toBe(false)
    expect(wrapper.find('.dock-container').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'UnifiedVoiceOverlay' }).exists()).toBe(true)
  })

  it('closes the pop-out when the call ends', async () => {
    h.store = makeStore([member('bob')])
    wrapper = await mountDock()
    h.popout.active = true
    await flushPromises()
    wrapper.unmount()
    wrapper = null
    expect(closeCallPopout).toHaveBeenCalled()
  })
})
