import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { reactive } from 'vue'
import { resetLayersForTests } from '@/utils/a11y/layers'

// The call view's chat toggle and pop-out control: Chat opens the call's chat
// beside the call and names its panel, a dot marks new messages while it is
// closed, and closing returns focus to the toggle. Popped out, the view is not
// modal, offers Return in place of minimize and close, and its unmount (the
// call ended) closes the window.

const h = vi.hoisted(() => ({ store: null as any, chat: null as any, popout: null as any }))
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
vi.mock('@/components/activities/ActivityLauncher.vue', () => stub('ActivityLauncher'))
vi.mock('@/components/activities/ActivityStage.vue', () => stub('ActivityStage'))
vi.mock('@/components/activities/ActivityInvite.vue', () => stub('ActivityInvite'))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn() }) }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => h.store }))
vi.mock('@/stores/spatialAudio', () => ({ useSpatialAudioStore: () => ({ isPanelVisible: false, settings: { enabled: false }, togglePanel: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'me' } } }) }))
vi.mock('@/composables/useKonamiCode', () => ({ useKonamiCode: () => ({ reset: vi.fn() }) }))
vi.mock('@/services/EasterEggService', () => ({ easterEggService: { initialize: vi.fn(), subscribe: vi.fn(), cleanup: vi.fn(), activate: vi.fn(), deactivate: vi.fn() } }))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({ getUserAvatarUrl: () => ({ value: '' }), getUserDisplayName: () => ({ value: '' }) }) }))
vi.mock('@/services/DMCallSignaling', () => ({ dmCallSignaling: { callStateVersion: { value: 0 }, getActiveCall: () => null } }))
vi.mock('@/composables/useCallSwitch', () => ({ dmConversationIdFromChannel: () => null }))
vi.mock('@/services/nativePtt', () => ({ armNativePtt: vi.fn(), disarmNativePtt: vi.fn() }))
vi.mock('@/utils/platform', () => ({ isTauriDesktop: () => false, isMobileUserAgent: () => false }))
vi.mock('../useSoundboardButton', async () => {
  const { ref } = await import('vue')
  return { useSoundboardButton: () => ({ available: ref(false), visible: ref(false), anchor: ref(null), toggle: vi.fn(), close: vi.fn() }) }
})
vi.mock('../VoiceTile.vue', () => stub('VoiceTile'))
vi.mock('../VoiceSettingsPanel.vue', () => stub('VoiceSettingsPanel'))
vi.mock('../SpatialAudioPanel.vue', () => stub('SpatialAudioPanel'))
vi.mock('../DeviceSelector.vue', () => stub('DeviceSelector'))
vi.mock('../VoiceEncryptionBadge.vue', () => stub('VoiceEncryptionBadge'))
vi.mock('../VoiceCallBanner.vue', () => stub('VoiceCallBanner'))
vi.mock('../StreamQualityPicker.vue', () => stub('StreamQualityPicker'))
vi.mock('../LiveReactionPopover.vue', () => stub('LiveReactionPopover'))
vi.mock('../SoundboardActivity.vue', () => stub('SoundboardActivity'))
vi.mock('../SoundboardPopover.vue', () => stub('SoundboardPopover'))
vi.mock('../../easteregg/ConfettiEffect.vue', () => stub('ConfettiEffect'))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/DisplayName.vue', () => stub('DisplayName'))
vi.mock('../CallSideChat.vue', async () => {
  const { h: render } = await import('vue')
  return {
    __esModule: true,
    default: {
      name: 'CallSideChat',
      props: ['id', 'autofocus'],
      emits: ['close'],
      setup(props: { id: string }, { emit }: { emit: (e: 'close') => void }) {
        return () => render('section', { id: props.id, 'data-testid': 'call-side-chat' }, [
          render('button', { type: 'button', 'data-testid': 'call-chat-close', onClick: () => emit('close') }, 'close'),
        ])
      },
    },
  }
})
vi.mock('../callChat', async () => {
  const { computed, reactive: r, ref } = await import('vue')
  const state = r({ available: true, open: false, unread: false })
  h.chat = {
    state,
    showTarget: vi.fn(),
    setCallChatOpen: vi.fn((next: boolean) => { state.open = next }),
  }
  return {
    setCallChatOpen: h.chat.setCallChatOpen,
    useCallChat: () => ({
      target: computed(() => ({ kind: 'channel', serverId: 's1', channelId: 'c1' })),
      available: computed(() => state.available),
      open: computed(() => state.open),
      width: ref(360),
      shown: computed(() => state.open && state.available && (h.store.isOverlayVisible || h.popout.active)),
      routed: computed(() => true),
      showTarget: h.chat.showTarget,
      hosts: () => false,
    }),
    useCallChatUnread: () => computed(() => state.unread && !state.open),
  }
})
vi.mock('../callPopout', async () => {
  const { computed, reactive: r } = await import('vue')
  const state = r({ active: false, root: null as HTMLElement | null, generation: 0 })
  h.popout = state
  return {
    callPopout: state,
    callPopoutActive: computed(() => state.active),
    callPopoutSupported: () => true,
    openCallPopout: vi.fn(async () => true),
    closeCallPopout: vi.fn(),
    focusCallPopout: vi.fn(),
    setCallPopoutTitle: vi.fn(),
    observeResize: () => () => {},
  }
})

import UnifiedVoiceOverlay from '../UnifiedVoiceOverlay.vue'
import { closeCallPopout, openCallPopout } from '../callPopout'
import { resetKeybindsForTests, useKeybinds } from '@/composables/useKeybinds'

const member = (userId: string) => ({
  userId, isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: false,
  isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0,
})

function makeStore() {
  const store = reactive({
    isOverlayVisible: true,
    isConnected: true,
    currentChannelId: 'c1',
    optimisticChannelId: null,
    dmOtherUserId: null,
    connectionMode: 'livekit',
    transportLabel: 'SFU',
    isEncrypted: false,
    callStartTime: null,
    connectionStats: { total: 2, withVideo: 0, speaking: 0 },
    localState: member('me'),
    allUsers: [member('bob')],
    get allParticipants() { return [this.localState, ...this.allUsers] },
    viewMode: 'normal',
    fullscreenUserId: null,
    fullscreenSource: 'camera',
    isFullWindowMode: false,
    liveReactionsAvailable: false,
    toggleOverlay: vi.fn(() => { store.isOverlayVisible = !store.isOverlayVisible }),
    toggleMute: vi.fn(),
    toggleDeafen: vi.fn(),
    toggleVideo: vi.fn(),
    toggleScreenShare: vi.fn(),
    exitFullscreen: vi.fn(),
    enterFullscreen: vi.fn(),
    leaveVoiceChannel: vi.fn(async () => true),
  })
  return store
}

let wrapper: VueWrapper | null = null

beforeEach(() => {
  resetKeybindsForTests()
  h.store = makeStore()
  h.chat.state.available = true
  h.chat.state.open = false
  h.chat.state.unread = false
  h.popout.active = false
  h.popout.root = null
  vi.mocked(openCallPopout).mockClear()
  vi.mocked(closeCallPopout).mockClear()
  h.chat.showTarget.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  useKeybinds().cleanupListeners()
  resetKeybindsForTests()
  resetLayersForTests()
  document.body.innerHTML = ''
})

async function open() {
  wrapper = mount(UnifiedVoiceOverlay, { props: { channelName: 'lounge' }, attachTo: document.body })
  await flushPromises()
  return document.querySelector<HTMLElement>('[data-testid="voice-overlay"]')!
}

const toggle = () => document.querySelector<HTMLButtonElement>('[data-testid="call-chat-toggle"]')

describe('call view side chat', () => {
  it('has no Chat button when the call has no readable chat', async () => {
    h.chat.state.available = false
    await open()
    expect(toggle()).toBeNull()
  })

  it('opens the chat beside the call, named and controlled by its button', async () => {
    const view = await open()
    const button = toggle()!
    expect(button.getAttribute('aria-label')).toBe('voice.callChat.toggle')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.hasAttribute('aria-controls')).toBe(false)

    button.click()
    await flushPromises()
    expect(h.chat.setCallChatOpen).toHaveBeenCalledWith(true)
    expect(h.chat.showTarget).toHaveBeenCalledTimes(1)
    const panel = view.querySelector<HTMLElement>('[data-testid="call-side-chat"]')!
    expect(panel).not.toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe(panel.id)
    expect(view.classList.contains('with-chat')).toBe(true)

    button.click()
    await flushPromises()
    expect(view.querySelector('[data-testid="call-side-chat"]')).toBeNull()
    expect(view.classList.contains('with-chat')).toBe(false)
  })

  it("returns focus to Chat when the panel's close button closes it", async () => {
    h.chat.state.open = true
    const view = await open()
    const close = view.querySelector<HTMLButtonElement>('[data-testid="call-chat-close"]')!
    close.focus()
    close.click()
    await flushPromises()
    expect(view.querySelector('[data-testid="call-side-chat"]')).toBeNull()
    expect(document.activeElement).toBe(toggle())
  })

  it('marks new messages on the closed chat with a dot and in its name', async () => {
    await open()
    expect(document.querySelector('[data-testid="call-chat-unread"]')).toBeNull()
    h.chat.state.unread = true
    await flushPromises()
    expect(document.querySelector('[data-testid="call-chat-unread"]')?.getAttribute('aria-hidden')).toBe('true')
    expect(toggle()!.getAttribute('aria-label')).toBe('voice.callChat.toggleUnread')
    toggle()!.click()
    await flushPromises()
    expect(document.querySelector('[data-testid="call-chat-unread"]')).toBeNull()
    expect(toggle()!.getAttribute('aria-label')).toBe('voice.callChat.toggle')
  })
})

describe('call view pop-out control', () => {
  it('pops the view out under the channel title', async () => {
    const view = await open()
    const button = view.querySelector<HTMLButtonElement>('[data-testid="call-popout-toggle"]')!
    expect(button.getAttribute('aria-label')).toBe('voice.popout.open')
    button.click()
    await flushPromises()
    expect(openCallPopout).toHaveBeenCalledWith({ title: 'voice.popout.windowTitle' })
  })

  it('popped out, is not modal and offers Return in place of minimize and close', async () => {
    h.popout.active = true
    h.popout.root = document.createElement('div')
    document.body.append(h.popout.root)
    h.store.isOverlayVisible = false
    await open()
    const view = h.popout.root.querySelector<HTMLElement>('[data-testid="voice-overlay"]')!
    expect(view).not.toBeNull()
    expect(view.hasAttribute('aria-modal')).toBe(false)
    const labels = Array.from(view.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))
    expect(labels).toContain('voice.popout.return')
    expect(labels).not.toContain('voice.minimizeCallView')
    expect(labels).not.toContain('voice.closeCallView')
    expect(labels).not.toContain('voice.fullScreen')

    view.querySelector<HTMLButtonElement>('[data-testid="call-popout-toggle"]')!.click()
    expect(closeCallPopout).toHaveBeenCalledTimes(1)
  })

  it('closes the pop-out when it unmounts popped out (the call ended)', async () => {
    h.popout.active = true
    await open()
    wrapper!.unmount()
    wrapper = null
    expect(closeCallPopout).toHaveBeenCalledTimes(1)
  })

  it('does not minimize on Escape while popped out', async () => {
    vi.useFakeTimers()
    try {
      const kb = useKeybinds()
      kb.activateContext('voice-connected')
      kb.setupListeners()
      h.popout.active = true
      const view = await open()
      const mute = view.querySelector<HTMLElement>('[data-testid="voice-mute"]')!
      mute.focus()
      mute.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
      vi.advanceTimersByTime(400)
      expect(h.store.toggleOverlay).not.toHaveBeenCalled()
      expect(wrapper!.emitted('minimize')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
