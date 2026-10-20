import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import UnifiedVoiceDock from '../UnifiedVoiceDock.vue'
import { closeCallPopout, focusCallPopout, openCallPopout } from '../callPopout'
import { floatDock } from '@/services/floatingDock'

// The in-app side of the floating dock: Float among the minimized controls; a drag released
// outside the window tears the dock off at the release point; while it floats the in-app
// dock is gone; dropped back, it takes the place it landed, and Back to the app opens the
// call view.

const h = vi.hoisted(() => ({
  store: null as any,
  popout: null as any,
  storage: new Map<string, string>(),
  floating: null as any,
  dockHandler: null as null | ((command: any) => void),
}))
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
vi.mock('@/services/floatingDock', async () => {
  const { ref } = await import('vue')
  h.floating = ref(false)
  return {
    floatingDockActive: h.floating,
    floatingDockSupported: () => true,
    floatDock: vi.fn(async () => { h.floating.value = true; return true }),
    closeFloatingDock: vi.fn(async () => { h.floating.value = false }),
    screenPointFromClient: vi.fn(async (p: { x: number; y: number }) => ({ x: p.x + 1000, y: p.y + 500 })),
    clientPointFromLogical: (p: { x: number; y: number }) => p,
    onFloatingDockCommand: (fn: (command: any) => void) => {
      h.dockHandler = fn
      return () => { h.dockHandler = null }
    },
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
  h.floating.value = false
  vi.mocked(floatDock).mockClear()
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

async function minimized(w: VueWrapper) {
  await button(w, 'dock-minimize').trigger('click')
  await flushPromises()
  await nextTick()
  expect(w.find('.minimized-container').exists()).toBe(true)
}

function mouse(type: string, x: number, y: number) {
  return new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true })
}

describe('UnifiedVoiceDock floating dock', () => {
  it('offers Float among the minimized controls and floats from where the dock sits', async () => {
    h.store = makeStore([member('bob')])
    wrapper = await mountDock()
    await minimized(wrapper)
    const float = button(wrapper, 'mini-float')
    expect(float.attributes('aria-label')).toBe('voice.floatingDock.float')
    await float.trigger('click')
    await flushPromises()
    // jsdom rects sit at 0,0; the screen mapping is mocked as +1000/+500.
    expect(floatDock).toHaveBeenCalledWith({ x: 1000, y: 500 })
  })

  it('tears off where a drag is released outside the window, and not inside it', async () => {
    h.store = makeStore([member('bob')])
    wrapper = await mountDock()
    await minimized(wrapper)
    const info = wrapper.find('.minimized-info')

    info.element.dispatchEvent(mouse('mousedown', 30, 20))
    document.dispatchEvent(mouse('mousemove', 300, 200))
    document.dispatchEvent(mouse('mouseup', 300, 200))
    await flushPromises()
    expect(floatDock).not.toHaveBeenCalled()

    await nextTick()
    info.element.dispatchEvent(mouse('mousedown', 30, 20))
    document.dispatchEvent(mouse('mousemove', -60, 40))
    await nextTick()
    expect(wrapper.find('.minimized-container').classes()).toContain('tear-off-ready')
    document.dispatchEvent(mouse('mouseup', -60, 40))
    await flushPromises()
    // The dock's top-left: release point minus the grab offset (30, 20), mapped to the screen.
    expect(floatDock).toHaveBeenCalledWith({ x: -90 + 1000, y: 20 + 500 })
  })

  it('is gone from the app while floating and comes back where it was dropped', async () => {
    h.store = makeStore([member('bob')])
    wrapper = await mountDock()
    await minimized(wrapper)
    h.floating.value = true
    await nextTick()
    expect(wrapper.find('.minimized-container').exists()).toBe(false)

    h.floating.value = false
    h.dockHandler?.({ type: 'redock', at: { x: 200, y: 300 } })
    await nextTick()
    const container = wrapper.find('.minimized-container')
    expect(container.exists()).toBe(true)
    const style = (container.element as HTMLElement).style
    expect(style.left).toBe('200px')
    // jsdom's viewport is 768 px tall; an unmeasured dock counts as 52 px.
    expect(style.bottom).toBe(`${window.innerHeight - 300 - 52}px`)
  })

  it('Back to the app opens the call view', async () => {
    h.store = makeStore([member('bob')])
    wrapper = await mountDock()
    await minimized(wrapper)
    h.floating.value = true
    await nextTick()
    h.floating.value = false
    h.dockHandler?.({ type: 'expand' })
    await flushPromises()
    await nextTick()
    expect(wrapper.findComponent({ name: 'UnifiedVoiceOverlay' }).exists()).toBe(true)
  })
})
