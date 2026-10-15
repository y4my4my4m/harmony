import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import UnifiedVoiceDock from '../UnifiedVoiceDock.vue'

// Dock controls for keyboard and screen-reader users: a labelled region,
// toggle buttons with stable names and pressed state, a real Expand button
// in the minimized panel, its audio pair reachable at every position, and
// focus that follows the controls a mode switch removes.

const h = vi.hoisted(() => ({ store: null as any, storage: new Map<string, string>() }))
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
})

async function mountDock() {
  const dock = mount(UnifiedVoiceDock, { attachTo: document.body })
  await flushPromises()
  await nextTick()
  return dock
}

const button = (w: VueWrapper, testid: string) => w.find(`[data-testid="${testid}"]`)

describe('UnifiedVoiceDock accessibility', () => {
  it('is a region named Voice connection', async () => {
    h.store = makeStore([member('bob')])
    wrapper = await mountDock()
    const root = wrapper.find('[data-testid="voice-dock"]')
    expect(root.element.tagName).toBe('SECTION')
    expect(root.attributes('aria-label')).toBe('voice.region')
  })

  it('gives mute, deafen, camera and share stable names with pressed state', async () => {
    h.store = makeStore([member('bob')])
    wrapper = await mountDock()
    const mute = button(wrapper, 'dock-mute')
    expect(mute.attributes('aria-label')).toBe('voice.mute')
    expect(mute.attributes('aria-pressed')).toBe('false')
    await mute.trigger('click')
    expect(h.store.toggleMute).toHaveBeenCalled()
    await nextTick()
    expect(mute.attributes('aria-label')).toBe('voice.mute')
    expect(mute.attributes('aria-pressed')).toBe('true')

    const deafen = button(wrapper, 'dock-deafen')
    expect(deafen.attributes('aria-label')).toBe('voice.deafen')
    expect(deafen.attributes('aria-pressed')).toBe('false')
    expect(button(wrapper, 'dock-camera').attributes('aria-pressed')).toBe('false')
    const share = button(wrapper, 'dock-share')
    expect(share.attributes('aria-label')).toBe('voice.shareScreen')
    expect(share.attributes('aria-pressed')).toBe('false')
    expect(share.attributes('aria-haspopup')).toBe('dialog')
  })

  it('names every icon-only control', async () => {
    h.store = makeStore([member('bob')])
    wrapper = await mountDock()
    const unnamed = wrapper.findAll('button').filter((b) => !b.attributes('aria-label') && !b.text().trim())
    expect(unnamed.map((b) => b.html())).toEqual([])
  })

  it('minimizes to a panel with an Expand button that takes focus and expands back', async () => {
    h.store = makeStore([member('bob')])
    wrapper = await mountDock()
    const minimize = button(wrapper, 'dock-minimize')
    ;(minimize.element as HTMLElement).focus()
    await minimize.trigger('click')
    await flushPromises()

    const expand = button(wrapper, 'mini-expand')
    expect(expand.exists()).toBe(true)
    expect(expand.attributes('aria-label')).toBe('voice.expandPanel')
    expect(document.activeElement).toBe(expand.element)

    await expand.trigger('click')
    await flushPromises()
    expect(wrapper.find('.dock-container').exists()).toBe(true)
    expect(document.activeElement).toBe(button(wrapper, 'dock-minimize').element)
  })

  it('keeps the minimized mute and deafen in reach with pressed state', async () => {
    h.store = makeStore([member('bob')])
    wrapper = await mountDock()
    await button(wrapper, 'dock-minimize').trigger('click')
    await flushPromises()
    const mute = button(wrapper, 'mini-mute')
    expect(mute.attributes('aria-label')).toBe('voice.mute')
    expect(mute.attributes('aria-pressed')).toBe('false')
    expect(mute.attributes('tabindex')).toBeUndefined()
    await mute.trigger('click')
    await nextTick()
    expect(mute.attributes('aria-pressed')).toBe('true')
    expect(button(wrapper, 'mini-deafen').attributes('aria-label')).toBe('voice.deafen')
  })

  it('names the participants disclosure and ties it to its panel', async () => {
    h.store = makeStore([member('bob')])
    wrapper = await mountDock()
    const toggle = wrapper.find('.participants-btn')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await toggle.trigger('click')
    await flushPromises()
    expect(toggle.attributes('aria-expanded')).toBe('true')
    const panelId = toggle.attributes('aria-controls')
    expect(panelId).toBeTruthy()
    expect(document.getElementById(panelId!)).not.toBeNull()
  })

  it('hands the call view the expand button as its focus fallback', async () => {
    h.store = makeStore([member('bob')])
    wrapper = await mountDock()
    await wrapper.find('[data-voice-expand]').trigger('click')
    await flushPromises()
    const overlay = wrapper.findComponent({ name: 'UnifiedVoiceOverlay' })
    expect(overlay.exists()).toBe(true)
    const attrs = overlay.vm.$attrs as Record<string, unknown>
    const returnFocus = (attrs['return-focus'] ?? attrs.returnFocus) as () => HTMLElement | null
    expect(typeof returnFocus).toBe('function')

    h.store.isOverlayVisible = false
    overlay.vm.$emit('minimize')
    await flushPromises()
    expect(returnFocus()).toBe(wrapper.find('[data-voice-expand]').element)
  })

  it('moves focus to the channel row after leaving from the dock', async () => {
    h.store = makeStore([member('bob')])
    const row = document.createElement('div')
    row.setAttribute('data-channel-id', 'c1')
    row.innerHTML = '<div role="button" tabindex="0">General</div>'
    document.body.appendChild(row)
    wrapper = await mountDock()
    const leave = button(wrapper, 'dock-leave')
    ;(leave.element as HTMLElement).focus()
    // Leaving unmounts the dock; the control that held focus goes with it.
    h.store.leaveVoiceChannel.mockImplementation(async () => {
      ;(document.activeElement as HTMLElement | null)?.blur()
      return true
    })
    await leave.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(row.querySelector('[role="button"]'))
    row.remove()
  })
})
