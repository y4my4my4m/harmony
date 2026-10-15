import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { participantLabel, participantStates } from '../participantLabel'
import VoiceTile from '../VoiceTile.vue'
import VoiceChannelParticipants from '../VoiceChannelParticipants.vue'
import RecentSpeakers from '../RecentSpeakers.vue'

// Accessible names of tiles, participant rows and recent speakers carry the
// state the icons and rings show; rows are buttons that open the voice menu.

const h = vi.hoisted(() => ({ store: null as any }))
const { stub } = vi.hoisted(() => ({ stub: (name: string) => ({ __esModule: true, default: { name, render: () => null } }) }))
const translate = vi.hoisted(() => (key: string, params?: Record<string, unknown>) => {
  const words: Record<string, string> = {
    'voice.statusMuted': 'Muted',
    'voice.statusDeafened': 'Deafened',
    'voice.statusCameraOn': 'Camera on',
    'voice.statusStreaming': 'Streaming',
    'voice.statusSpeaking': 'Speaking',
    'voice.mutedByYou': 'Muted by you',
    'voice.moderation.serverMuted': 'Server muted',
    'voice.moderation.serverDeafened': 'Server deafened',
    'voice.live': 'Live',
    'voice.selfName': `${params?.name} (you)`,
    'voice.inCallCount': `${params?.count} in call`,
    'voice.watchStreamOf': `Watch ${params?.name}'s stream`,
  }
  return words[key] ?? key
})

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: translate }) }))
vi.mock('@/composables/useT', () => ({ useT: () => ({ t: translate, locale: { value: 'en' } }) }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => h.store }))
vi.mock('@/stores/voiceModeration', () => ({
  NO_VOICE_CAPABILITIES: { mute: false, deafen: false, move: false, kick: false, ban: false },
  useVoiceModerationStore: () => ({
    flagsOf: () => ({ muted: false, deafened: false }),
    channelPowers: async () => ({ mute: false, deafen: false, move: false, kick: false, ban: false }),
  }),
}))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ servers: [], currentServer: null, channels: [] }) }))
vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({
    getUserProfile: (id: string) => ({ value: { display_name: id === 'me' ? 'Me' : 'Bob' } }),
    getUserDisplayName: (id: string) => ({ value: id === 'me' ? 'Me' : 'Bob' }),
    getUserAvatarUrl: () => ({ value: '/a.webp' }),
    getUser: (id: string) => ({ value: { displayName: id === 'me' ? 'Me' : 'Bob' } }),
  }),
}))
vi.mock('@/utils/bannerUtils', () => ({ getBannerUrl: () => null }))
vi.mock('@/utils/renderFallback', () => ({ withRenderFallback: (url: string | null) => url }))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/DisplayName.vue', () => stub('DisplayName'))
vi.mock('../VoiceEncryptionBadge.vue', () => stub('VoiceEncryptionBadge'))
vi.mock('../TileVolumeControl.vue', () => stub('TileVolumeControl'))
vi.mock('../LiveReactionLayer.vue', () => stub('LiveReactionLayer'))
vi.mock('../LiveReactionPopover.vue', () => stub('LiveReactionPopover'))
vi.mock('../VoiceUserContextMenu.vue', () => ({
  __esModule: true,
  default: { name: 'VoiceUserContextMenu', props: ['userState', 'visible', 'x', 'y', 'source'], emits: ['close'], render: () => null },
}))

const member = (userId: string, extra: Record<string, unknown> = {}) => ({
  userId, isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: false,
  isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0, ...extra,
})

function makeStore(bob: ReturnType<typeof member>) {
  return reactive({
    localState: member('me'),
    allUsers: [bob],
    connectionMode: 'livekit',
    isEncrypted: false,
    viewMode: 'normal',
    fullscreenUserId: null,
    fullscreenSource: 'camera',
    pipActive: false,
    pipUserId: null,
    streamUpdateCounter: 0,
    callStartTime: null,
    liveReactionsAvailable: false,
    recentSpeakers: [{ userId: 'bob', lastSpokeAt: 1 }],
    get getRecentSpeakers() { return this.recentSpeakers },
    get activelySpeakingUserIds() { return this.allUsers.filter((u: any) => u.isSpeaking).map((u: any) => u.userId) },
    isWatchingStream: () => true,
    getConnectionQuality: () => 'good',
    getUserVolume: () => 100,
    getUserScreenShareVolume: () => 100,
    isUserLocallyMuted: () => false,
    attachVideoToElement: vi.fn(() => true),
    detachVideoFromElement: vi.fn(),
    watchStream: vi.fn(),
    enterFullscreen: vi.fn(),
    isOverlayVisible: false,
  })
}

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('participantLabel', () => {
  it('names a server mute or deafen in place of the member\'s own', () => {
    const t = (key: string) => translate(key)
    expect(participantStates(t, { muted: true, serverMuted: true })).toEqual(['Server muted'])
    expect(participantStates(t, { deafened: true, serverMuted: true, serverDeafened: true })).toEqual(['Server deafened'])
    expect(participantLabel(t, 'Bob', { serverMuted: true, camera: true })).toBe('Bob, Server muted, Camera on')
  })

  it('lists state in a fixed order; deafened replaces muted', () => {
    expect(participantStates(translate, { muted: true, deafened: true, camera: true, streaming: true, speaking: true }))
      .toEqual(['Deafened', 'Camera on', 'Streaming', 'Speaking'])
    expect(participantLabel(translate, 'Bob', { muted: true, mutedByYou: true })).toBe('Bob, Muted, Muted by you')
    expect(participantLabel(translate, 'Me', { self: true })).toBe('Me (you)')
  })
})

describe('VoiceTile name', () => {
  it('carries mute, camera and stream state on a camera tile', async () => {
    const bob = member('bob', { isMuted: true, isVideoEnabled: true, isScreenSharing: true })
    h.store = makeStore(bob)
    wrapper = mount(VoiceTile, { props: { userState: bob, source: 'camera' } })
    await nextTick()
    expect(wrapper.attributes('aria-label')).toBe('Bob, Muted, Camera on, Streaming')
    expect(wrapper.attributes('role')).toBe('group')
  })

  it('adds speaking and keeps it through the gap between words', async () => {
    vi.useFakeTimers()
    try {
      const bob = member('bob')
      h.store = makeStore(bob)
      wrapper = mount(VoiceTile, { props: { userState: bob, source: 'camera' } })
      h.store.allUsers[0].isSpeaking = true
      await nextTick()
      await nextTick()
      expect(wrapper.attributes('aria-label')).toBe('Bob, Speaking')
      h.store.allUsers[0].isSpeaking = false
      await nextTick()
      vi.advanceTimersByTime(500)
      await nextTick()
      expect(wrapper.attributes('aria-label')).toBe('Bob, Speaking')
      vi.advanceTimersByTime(1000)
      await nextTick()
      expect(wrapper.attributes('aria-label')).toBe('Bob')
    } finally {
      vi.useRealTimers()
    }
  })

  it('names a screen tile as live', async () => {
    const bob = member('bob', { isScreenSharing: true })
    h.store = makeStore(bob)
    wrapper = mount(VoiceTile, { props: { userState: bob, source: 'screen' } })
    await nextTick()
    expect(wrapper.attributes('aria-label')).toBe('Bob, Live')
  })
})

describe('VoiceChannelParticipants rows', () => {
  it('are buttons in a labelled list whose names carry state', async () => {
    const bob = member('bob', { isDeafened: true, isMuted: true })
    h.store = makeStore(bob)
    wrapper = mount(VoiceChannelParticipants, {
      props: { participants: [h.store.localState, bob], sessionStartTime: null },
      attachTo: document.body,
    })
    await flushPromises()
    const list = wrapper.find('ul.participants-list')
    const header = wrapper.find('.participant-count')
    expect(list.attributes('aria-labelledby')).toBe(header.attributes('id'))
    expect(header.text()).toBe('2 in call')
    const rows = wrapper.findAll('button.participant-item')
    expect(rows.map((r) => r.attributes('aria-label'))).toEqual(['Me (you)', 'Bob, Deafened'])
    expect(rows[1].attributes('aria-haspopup')).toBe('menu')
  })

  it('open the voice menu on activation and return focus when it closes', async () => {
    const bob = member('bob')
    h.store = makeStore(bob)
    wrapper = mount(VoiceChannelParticipants, {
      props: { participants: [bob], sessionStartTime: null },
      attachTo: document.body,
    })
    await flushPromises()
    const row = wrapper.find('button.participant-item')
    ;(row.element as HTMLElement).focus()
    await row.trigger('click')
    await nextTick()
    const menu = wrapper.findComponent({ name: 'VoiceUserContextMenu' })
    expect(menu.exists()).toBe(true)
    expect(row.attributes('aria-expanded')).toBe('true')

    ;(document.activeElement as HTMLElement | null)?.blur()
    menu.vm.$emit('close')
    await flushPromises()
    expect(document.activeElement).toBe(row.element)
  })

  it('offer a separate watch button for a remote stream', async () => {
    const bob = member('bob', { isScreenSharing: true })
    h.store = makeStore(bob)
    wrapper = mount(VoiceChannelParticipants, { props: { participants: [bob], sessionStartTime: null } })
    await flushPromises()
    const watch = wrapper.find('button.live-pill')
    expect(watch.attributes('aria-label')).toBe("Watch Bob's stream")
    await watch.trigger('click')
    expect(h.store.watchStream).toHaveBeenCalledWith('bob')
    expect(h.store.enterFullscreen).toHaveBeenCalledWith('bob', 'screen')
  })
})

describe('RecentSpeakers', () => {
  it('is a labelled list naming who is speaking', async () => {
    const bob = member('bob', { isSpeaking: true })
    h.store = makeStore(bob)
    wrapper = mount(RecentSpeakers, { global: { stubs: { 'transition-group': false } } })
    await flushPromises()
    const list = wrapper.find('ul')
    expect(list.attributes('aria-label')).toBe('voice.recentSpeakers')
    expect(list.find('li .sr-only').text()).toBe('Bob, Speaking')
  })
})
