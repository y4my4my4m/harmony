import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { reactive } from 'vue'
import { resetLayersForTests } from '@/utils/a11y/layers'

// The call view is a modal dialog named by its channel heading: focus moves
// in and back out, the toggles have stable names with pressed state, and its
// keybind handlers come off the stack on unmount without taking the store's
// mute and deafen with them. The exit keybind acts only with focus inside.

const h = vi.hoisted(() => ({ store: null as any }))
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
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn() }) }))
vi.mock('../callChat', async () => {
  const { computed, ref } = await import('vue')
  const open = ref(false)
  return {
    setCallChatOpen: (next: boolean) => { open.value = next },
    useCallChat: () => ({
      target: computed(() => null),
      available: computed(() => false),
      open,
      width: ref(360),
      shown: computed(() => false),
      routed: computed(() => false),
      showTarget: () => {},
      hosts: () => false,
    }),
    useCallChatUnread: () => computed(() => false),
  }
})

import UnifiedVoiceOverlay from '../UnifiedVoiceOverlay.vue'
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
    toggleMute: vi.fn(() => { store.localState.isMuted = !store.localState.isMuted }),
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
let opener: HTMLButtonElement

beforeEach(() => {
  localStorage.clear()
  resetKeybindsForTests()
  opener = document.createElement('button')
  opener.textContent = 'Open call view'
  document.body.appendChild(opener)
  opener.focus()
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
  h.store = makeStore()
  wrapper = mount(UnifiedVoiceOverlay, { props: { channelName: 'General' }, attachTo: document.body })
  await flushPromises()
  return document.querySelector<HTMLElement>('[data-testid="voice-overlay"]')!
}

const press = (code: string, init: KeyboardEventInit = {}, target: EventTarget = document.activeElement ?? document.body) => {
  const event = new KeyboardEvent('keydown', { code, key: init.key ?? code, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('UnifiedVoiceOverlay', () => {
  it('is a modal dialog named by the channel heading, and takes focus', async () => {
    const dialog = await open()
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent?.trim()).toBe('General')
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toContain('voice.participantCount')
    expect(document.activeElement).toBe(dialog)
  })

  it('returns focus to the opener when it closes', async () => {
    await open()
    h.store.isOverlayVisible = false
    await flushPromises()
    expect(document.activeElement).toBe(opener)
  })

  it('names the call controls with stable labels and pressed state', async () => {
    const dialog = await open()
    const mute = dialog.querySelector<HTMLElement>('[data-testid="voice-mute"]')!
    expect(mute.getAttribute('aria-label')).toBe('voice.mute')
    expect(mute.getAttribute('aria-pressed')).toBe('false')
    mute.click()
    await flushPromises()
    expect(mute.getAttribute('aria-label')).toBe('voice.mute')
    expect(mute.getAttribute('aria-pressed')).toBe('true')
    expect(dialog.querySelector('[data-testid="voice-deafen"]')?.getAttribute('aria-pressed')).toBe('false')
    const unnamed = Array.from(dialog.querySelectorAll('button')).filter((b) => !b.getAttribute('aria-label') && !b.textContent?.trim())
    expect(unnamed.map((b) => b.outerHTML)).toEqual([])
  })

  it('leaves the store mute and deafen handlers live after it unmounts', async () => {
    const kb = useKeybinds()
    kb.activateContext('voice-connected')
    kb.setupListeners()
    const storeMute = vi.fn()
    kb.registerHandler('toggle-mute', storeMute)
    await open()
    wrapper!.unmount()
    wrapper = null
    press('KeyM', { key: 'M', ctrlKey: true, shiftKey: true }, document.body)
    expect(storeMute).toHaveBeenCalledTimes(1)
  })

  it('handles the exit key only with focus inside the call view', async () => {
    const kb = useKeybinds()
    kb.activateContext('voice-connected')
    kb.setupListeners()
    const dialog = await open()

    const outside = document.createElement('input')
    document.body.appendChild(outside)
    outside.removeAttribute('inert')
    const ignored = press('Escape', { key: 'Escape' }, outside)
    expect(ignored.defaultPrevented).toBe(false)
    expect(h.store.toggleOverlay).not.toHaveBeenCalled()

    vi.useFakeTimers()
    try {
      const inside = dialog.querySelector<HTMLElement>('[data-testid="voice-mute"]')!
      inside.focus()
      const handled = press('Escape', { key: 'Escape' }, inside)
      expect(handled.defaultPrevented).toBe(true)
      vi.advanceTimersByTime(300)
      expect(h.store.toggleOverlay).toHaveBeenCalledTimes(1)
      expect(wrapper!.emitted('minimize')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
