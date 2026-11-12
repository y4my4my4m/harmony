import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import VoiceTile from '../VoiceTile.vue'

// In a server call the tile shows the member's server avatar; in a direct call, the account's.

const h = vi.hoisted(() => ({ store: null as any }))
const { stub } = vi.hoisted(() => ({ stub: (name: string) => ({ __esModule: true, default: { name, render: () => null } }) }))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => h.store }))
vi.mock('@/stores/voiceModeration', () => ({
  NO_VOICE_CAPABILITIES: { mute: false, deafen: false, move: false, kick: false, ban: false },
  useVoiceModerationStore: () => ({
    flagsOf: () => ({ muted: false, deafened: false }),
    channelPowers: async () => ({ mute: false, deafen: false, move: false, kick: false, ban: false }),
  }),
}))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({ getUserProfile: () => ({ value: null }) }) }))
vi.mock('@/composables/useMemberProfile', () => ({
  getMemberDisplayName: (_id: string, serverId: string | null) => ({ value: serverId ? 'Nick' : 'Account' }),
  getMemberAvatarUrl: (_id: string, serverId: string | null) => ({ value: serverId ? 'server.png' : 'account.png' }),
  getMemberBannerUrl: () => ({ value: null }),
}))
vi.mock('@/utils/bannerUtils', () => ({ getBannerUrl: () => null }))
vi.mock('@/utils/renderFallback', () => ({ withRenderFallback: (url: string | null) => url }))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/Avatar.vue', () => ({
  __esModule: true,
  default: { name: 'Avatar', props: ['src'], render: () => null },
}))
vi.mock('@/components/DisplayName.vue', () => ({
  __esModule: true,
  default: { name: 'DisplayName', props: ['userId', 'serverId', 'fallback'], render: () => null },
}))
vi.mock('../VoiceUserContextMenu.vue', () => stub('VoiceUserContextMenu'))
vi.mock('../TileVolumeControl.vue', () => stub('TileVolumeControl'))
vi.mock('../LiveReactionLayer.vue', () => stub('LiveReactionLayer'))
vi.mock('../LiveReactionPopover.vue', () => stub('LiveReactionPopover'))

const member = (userId: string) => ({
  userId, isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: false,
  isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0,
})

function makeStore(currentServerId: string) {
  return reactive({
    localState: member('me'),
    allUsers: [member('bob')],
    currentServerId,
    connectionMode: 'livekit',
    liveReactionsAvailable: false,
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

describe('VoiceTile server profile', () => {
  it('shows the server avatar and nickname in a server call', async () => {
    h.store = makeStore('server-1')
    wrapper = mount(VoiceTile, { props: { userState: h.store.allUsers[0], source: 'camera' } })
    await nextTick()
    expect(wrapper.findComponent({ name: 'Avatar' }).props('src')).toBe('server.png')
    expect(wrapper.findComponent({ name: 'DisplayName' }).props()).toMatchObject({ serverId: 'server-1', fallback: 'Nick' })
  })

  it('shows the account avatar in a direct call', async () => {
    h.store = makeStore('dm')
    wrapper = mount(VoiceTile, { props: { userState: h.store.allUsers[0], source: 'camera' } })
    await nextTick()
    expect(wrapper.findComponent({ name: 'Avatar' }).props('src')).toBe('account.png')
    expect(wrapper.findComponent({ name: 'DisplayName' }).props('serverId')).toBeNull()
  })
})
