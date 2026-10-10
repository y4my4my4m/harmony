import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import VoiceTile from '../VoiceTile.vue'

// A tile showing video carries a react control aimed at that feed, and a
// reaction layer keyed to it. Audio-only calls and avatar tiles get no control.

const h = vi.hoisted(() => ({ store: null as any }))
const { stub } = vi.hoisted(() => ({ stub: (name: string) => ({ __esModule: true, default: { name, render: () => null } }) }))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => h.store }))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({ getUserProfile: () => ({ value: null }) }) }))
vi.mock('@/utils/bannerUtils', () => ({ getBannerUrl: () => null }))
vi.mock('@/utils/renderFallback', () => ({ withRenderFallback: (url: string | null) => url }))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/DisplayName.vue', () => stub('DisplayName'))
vi.mock('../VoiceUserContextMenu.vue', () => stub('VoiceUserContextMenu'))
vi.mock('../TileVolumeControl.vue', () => stub('TileVolumeControl'))
vi.mock('../LiveReactionLayer.vue', () => ({
  __esModule: true,
  default: { name: 'LiveReactionLayer', props: ['userId', 'source', 'compact'], render: () => null },
}))
vi.mock('../LiveReactionPopover.vue', () => ({
  __esModule: true,
  default: { name: 'LiveReactionPopover', props: ['visible', 'anchor', 'target'], emits: ['close'], render: () => null },
}))

const member = (userId: string, extra: Record<string, unknown> = {}) => ({
  userId, isAudioEnabled: true, isVideoEnabled: true, isScreenSharing: true,
  isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0, ...extra,
})

function makeStore(available: boolean) {
  return reactive({
    localState: member('me'),
    allUsers: [member('bob')],
    connectionMode: 'livekit',
    liveReactionsAvailable: available,
    viewMode: 'normal',
    fullscreenUserId: null,
    fullscreenSource: 'camera',
    pipActive: false,
    pipUserId: null,
    streamUpdateCounter: 0,
    isWatchingStream: () => true,
    getConnectionQuality: () => 'good',
    getUserVolume: () => 100,
    getUserScreenShareVolume: () => 100,
    isUserLocallyMuted: () => false,
    attachVideoToElement: vi.fn(() => true),
    detachVideoFromElement: vi.fn(),
  })
}

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

const reactButton = () => wrapper!.find('button[aria-label="voice.react"]')

describe('VoiceTile live reactions', () => {
  it('keys the reaction layer to the tile feed', async () => {
    h.store = makeStore(true)
    wrapper = mount(VoiceTile, { props: { userState: h.store.allUsers[0], source: 'screen' } })
    await nextTick()
    expect(wrapper.findComponent({ name: 'LiveReactionLayer' }).props()).toMatchObject({ userId: 'bob', source: 'screen' })
  })

  it('opens the reaction bar aimed at this feed', async () => {
    h.store = makeStore(true)
    wrapper = mount(VoiceTile, { props: { userState: h.store.allUsers[0], source: 'screen' } })
    await nextTick()
    const popover = wrapper.findComponent({ name: 'LiveReactionPopover' })
    expect(popover.props('visible')).toBe(false)

    await reactButton().trigger('click')
    expect(reactButton().attributes('aria-expanded')).toBe('true')
    expect(popover.props('visible')).toBe(true)
    expect(popover.props('target')).toEqual({ userId: 'bob', source: 'screen' })
    expect(popover.props('anchor')).toBe(reactButton().element)

    popover.vm.$emit('close')
    await nextTick()
    expect(popover.props('visible')).toBe(false)
  })

  it('has no control in an audio-only call', async () => {
    h.store = makeStore(false)
    wrapper = mount(VoiceTile, { props: { userState: h.store.allUsers[0], source: 'screen' } })
    await nextTick()
    expect(reactButton().exists()).toBe(false)
  })

  it('has no control on an avatar tile', async () => {
    h.store = makeStore(true)
    const avatarOnly = member('carol', { isVideoEnabled: false, isScreenSharing: false })
    wrapper = mount(VoiceTile, { props: { userState: avatarOnly, source: 'camera' } })
    await nextTick()
    expect(reactButton().exists()).toBe(false)
  })
})
