import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import VoiceTile from '../VoiceTile.vue'

// The overlay mirrors the self camera exactly as the dock does; remote video
// and every screen share render as received.

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

const member = (userId: string, extra: Record<string, unknown> = {}) => ({
  userId, isAudioEnabled: true, isVideoEnabled: true, isScreenSharing: true,
  isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0, ...extra,
})

function makeStore() {
  return reactive({
    localState: member('me'),
    allUsers: [member('bob')],
    connectionMode: 'livekit',
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

async function videoClasses(userState: ReturnType<typeof member>, source: 'camera' | 'screen') {
  wrapper = mount(VoiceTile, { props: { userState, source } })
  await nextTick()
  const classes = wrapper.find('video').classes()
  wrapper.unmount()
  wrapper = null
  return classes
}

describe('VoiceTile self view', () => {
  it('mirrors only the local camera', async () => {
    h.store = makeStore()
    expect(await videoClasses(h.store.localState, 'camera')).toContain('mirrored')
    expect(await videoClasses(h.store.localState, 'screen')).not.toContain('mirrored')
    expect(await videoClasses(h.store.allUsers[0], 'camera')).not.toContain('mirrored')
    expect(await videoClasses(h.store.allUsers[0], 'screen')).not.toContain('mirrored')
  })

  it('keeps the fit class alongside the mirror', async () => {
    h.store = makeStore()
    wrapper = mount(VoiceTile, { props: { userState: h.store.localState, source: 'camera', fit: 'contain' } })
    await nextTick()
    expect(wrapper.find('video').classes()).toEqual(expect.arrayContaining(['tile-video', 'fit-contain', 'mirrored']))
  })
})
