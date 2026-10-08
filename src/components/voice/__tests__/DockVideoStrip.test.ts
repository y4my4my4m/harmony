import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, reactive } from 'vue'
import DockVideoStrip from '../DockVideoStrip.vue'
import { useDockVideoStrip } from '../useDockVideoStrip'

// The strip shows every camera and screen share in the call above the dock.
// A remote stream is received only after Watch; tiles attach through the
// store and detach when they go away. The harness wires the composable to the
// strip the way UnifiedVoiceDock does.

const m = vi.hoisted(() => ({
  store: null as any,
  storage: new Map<string, string>(),
  mobile: { value: false },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => m.store }))
vi.mock('@/composables/useViewport', async () => {
  const { ref } = await import('vue')
  const isMobileViewport = ref(false)
  m.mobile = isMobileViewport
  return { useViewport: () => ({ isMobileViewport, viewportHeight: ref(900) }) }
})
vi.mock('@/utils/userScopedStorage', () => ({
  userStorage: {
    getItem: (key: string) => m.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { m.storage.set(key, value) },
    removeItem: (key: string) => { m.storage.delete(key) },
  },
}))
vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({
    getUserAvatarUrl: (id: string) => ({ value: `/avatars/${id}.webp` }),
    getUserDisplayName: (id: string) => ({ value: id }),
  }),
}))
vi.mock('@/components/common/Icon.vue', () => ({ default: { name: 'Icon', render: () => null } }))
vi.mock('@/components/common/Avatar.vue', () => ({ default: { name: 'Avatar', render: () => null } }))
vi.mock('@/components/DisplayName.vue', () => ({ default: { name: 'DisplayName', render: () => null } }))

const stubs = { Icon: true, Avatar: true, DisplayName: true }

// happy-dom type-checks srcObject; track state is all the tile reads.
const fakeStream = (readyState: 'live' | 'ended') =>
  Object.assign(new MediaStream(), { getVideoTracks: () => [{ readyState }] }) as unknown as MediaStream

const member = (userId: string, extra: Record<string, unknown> = {}) => ({
  userId, isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: false,
  isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0, ...extra,
})

function makeStore(local: ReturnType<typeof member>, remote: ReturnType<typeof member>[], extra: Record<string, unknown> = {}) {
  return reactive({
    localState: local,
    allUsers: remote,
    get allParticipants() {
      return [this.localState, ...this.allUsers]
    },
    connectionMode: 'livekit' as string,
    watchedStreamUserIds: [] as string[],
    viewMode: 'normal',
    fullscreenUserId: null as string | null,
    fullscreenSource: 'camera',
    pipActive: false,
    pipUserId: null as string | null,
    streamUpdateCounter: 0,
    isWatchingStream(userId: string) {
      if (userId === this.localState.userId) return true
      if (this.connectionMode !== 'livekit') return true
      return this.watchedStreamUserIds.includes(userId)
    },
    watchStream: vi.fn(),
    togglePIP: vi.fn(),
    attachVideoToElement: vi.fn((_userId: string, el: HTMLVideoElement) => {
      el.srcObject = fakeStream('live')
      return true
    }),
    detachVideoFromElement: vi.fn(),
    ...extra,
  })
}

const order = (wrapper: VueWrapper) =>
  wrapper.findAll('.dock-tile').map(tile => `${tile.attributes('data-user-id')}:${tile.attributes('data-source')}`)

const Harness = defineComponent({
  emits: ['open'],
  setup(_, { emit, expose }) {
    const strip = useDockVideoStrip()
    expose({ expanded: strip.expanded })
    return () => h(DockVideoStrip, {
      tiles: strip.tiles.value,
      collapsed: strip.collapsed.value,
      hidden: strip.autoCollapsed.value,
      'onUpdate:collapsed': strip.setCollapsed,
      onOpen: (userId: string, source: string) => emit('open', userId, source),
    })
  },
})

const lastExpanded = (wrapper: VueWrapper) => (wrapper.vm as unknown as { expanded: boolean }).expanded

async function mountStrip() {
  const wrapper = mount(Harness, { attachTo: document.body, global: { stubs } })
  await nextTick()
  await nextTick()
  return wrapper
}

let wrapper: VueWrapper | null = null

beforeEach(() => {
  m.storage.clear()
  m.mobile.value = false
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('DockVideoStrip', () => {
  it('renders nothing in an audio-only call', async () => {
    m.store = makeStore(member('me'), [member('bob'), member('carol', { isSpeaking: true })])
    wrapper = await mountStrip()

    expect(wrapper.find('.dock-video-strip').exists()).toBe(false)
    expect(wrapper.find('.strip-expand').exists()).toBe(false)
    expect(lastExpanded(wrapper)).toBe(false)
    expect(m.store.attachVideoToElement).not.toHaveBeenCalled()
  })

  it('orders screen shares, remote cameras, then self, and mirrors only the self camera', async () => {
    m.store = makeStore(
      member('me', { isVideoEnabled: true, isScreenSharing: true }),
      [member('bob', { isVideoEnabled: true, isSpeaking: true }), member('carol', { isVideoEnabled: true, isScreenSharing: true })],
      { watchedStreamUserIds: ['carol'] },
    )
    wrapper = await mountStrip()

    expect(order(wrapper)).toEqual(['carol:screen', 'me:screen', 'bob:camera', 'carol:camera', 'me:camera'])
    expect(wrapper.find('.strip-count').text()).toContain('voice.onVideo {"n":3}')
    expect(lastExpanded(wrapper)).toBe(true)

    const tile = (id: string) => wrapper!.find(`.dock-tile[data-user-id="${id.split(':')[0]}"][data-source="${id.split(':')[1]}"]`)
    expect(tile('carol:screen').classes()).toContain('is-screen')
    expect(tile('bob:camera').classes()).toContain('speaking')
    expect(tile('carol:camera').classes()).not.toContain('speaking')
    expect(tile('me:camera').find('video').classes()).toContain('mirrored')
    expect(tile('me:screen').find('video').classes()).not.toContain('mirrored')
    expect(tile('bob:camera').find('video').classes()).not.toContain('mirrored')

    const attached = m.store.attachVideoToElement.mock.calls.map(([id, , source]: [string, unknown, string]) => `${id}:${source}`)
    expect(attached.sort()).toEqual(['bob:camera', 'carol:camera', 'carol:screen', 'me:camera', 'me:screen'])
  })

  it('rings the local camera tile from the local audio level', async () => {
    m.store = makeStore(member('me', { isVideoEnabled: true }), [])
    wrapper = await mountStrip()
    expect(wrapper.find('.dock-tile').classes()).not.toContain('speaking')

    m.store.localState.audioLevel = 30
    await nextTick()
    expect(wrapper.find('.dock-tile').classes()).toContain('speaking')

    m.store.localState.isMuted = true
    await nextTick()
    expect(wrapper.find('.dock-tile').classes()).not.toContain('speaking')
  })

  it('offers Watch on an unwatched stream and subscribes only on that click', async () => {
    m.store = makeStore(member('me'), [member('dave', { isScreenSharing: true })])
    wrapper = await mountStrip()

    const tile = wrapper.find('.dock-tile')
    expect(tile.find('video').exists()).toBe(false)
    expect(tile.find('.dock-tile-watch').exists()).toBe(true)
    expect(m.store.attachVideoToElement).not.toHaveBeenCalled()
    expect(wrapper.find('.strip-popout').exists()).toBe(false)

    await tile.trigger('click')
    expect(wrapper.emitted('open')).toEqual([['dave', 'screen']])
    expect(m.store.watchStream).not.toHaveBeenCalled()

    await tile.find('.dock-tile-watch').trigger('click')
    expect(m.store.watchStream).toHaveBeenCalledTimes(1)
    expect(m.store.watchStream).toHaveBeenCalledWith('dave')
    expect(wrapper.emitted('open')).toHaveLength(1)

    // stream-watch-changed from the transport
    m.store.watchedStreamUserIds = ['dave']
    await nextTick()
    await nextTick()
    expect(wrapper.find('.dock-tile video').exists()).toBe(true)
    expect(m.store.attachVideoToElement).toHaveBeenCalledWith('dave', expect.anything(), 'screen')
  })

  it('receives P2P streams without Watch', async () => {
    m.store = makeStore(member('me'), [member('dave', { isScreenSharing: true })], { connectionMode: 'p2p' })
    wrapper = await mountStrip()

    expect(wrapper.find('.dock-tile-watch').exists()).toBe(false)
    expect(m.store.attachVideoToElement).toHaveBeenCalledWith('dave', expect.anything(), 'screen')
    expect(m.store.watchStream).not.toHaveBeenCalled()
  })

  it('emits open with the participant and source on tile click', async () => {
    m.store = makeStore(member('me', { isVideoEnabled: true }), [member('bob', { isVideoEnabled: true })])
    wrapper = await mountStrip()

    await wrapper.find('.dock-tile[data-user-id="me"]').trigger('click')
    await wrapper.find('.dock-tile[data-user-id="bob"]').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('open')).toEqual([['me', 'camera'], ['bob', 'camera']])
  })

  it('pops out the popped, focused, or first received stream', async () => {
    m.store = makeStore(
      member('me'),
      [member('bob', { isScreenSharing: true }), member('carol', { isScreenSharing: true })],
      { watchedStreamUserIds: ['bob', 'carol'] },
    )
    wrapper = await mountStrip()

    await wrapper.find('.strip-popout').trigger('click')
    expect(m.store.togglePIP).toHaveBeenLastCalledWith('bob', 'draggable')

    m.store.viewMode = 'fullscreen'
    m.store.fullscreenUserId = 'carol'
    m.store.fullscreenSource = 'screen'
    await nextTick()
    await wrapper.find('.strip-popout').trigger('click')
    expect(m.store.togglePIP).toHaveBeenLastCalledWith('carol', 'draggable')

    m.store.pipActive = true
    m.store.pipUserId = 'bob'
    await nextTick()
    expect(wrapper.find('.strip-popout').classes()).toContain('active')
    await wrapper.find('.strip-popout').trigger('click')
    expect(m.store.togglePIP).toHaveBeenLastCalledWith('bob', 'draggable')
  })

  it('persists the collapsed state across mounts', async () => {
    m.store = makeStore(member('me'), [member('bob', { isVideoEnabled: true })])
    wrapper = await mountStrip()
    expect(wrapper.find('.dock-video-strip').exists()).toBe(true)

    await wrapper.find('.strip-collapse').trigger('click')
    await nextTick()
    expect(wrapper.find('.dock-video-strip').exists()).toBe(false)
    expect(wrapper.find('.strip-expand').exists()).toBe(true)
    expect(lastExpanded(wrapper)).toBe(false)
    expect(m.storage.get('voice-dock-video-strip-collapsed')).toBe('1')

    wrapper.unmount()
    wrapper = await mountStrip()
    expect(wrapper.find('.dock-video-strip').exists()).toBe(false)
    expect(wrapper.find('.strip-expand').exists()).toBe(true)
    expect(lastExpanded(wrapper)).toBe(false)

    await wrapper.find('.strip-expand').trigger('click')
    await nextTick()
    expect(wrapper.find('.dock-video-strip').exists()).toBe(true)
    expect(lastExpanded(wrapper)).toBe(true)
    expect(m.storage.has('voice-dock-video-strip-collapsed')).toBe(false)
  })

  it('detaches a tile when the camera turns off and every tile on unmount', async () => {
    m.store = makeStore(member('me', { isVideoEnabled: true }), [member('bob', { isVideoEnabled: true })])
    wrapper = await mountStrip()
    const bobVideo = wrapper.find('.dock-tile[data-user-id="bob"] video').element
    const meVideo = wrapper.find('.dock-tile[data-user-id="me"] video').element

    m.store.allUsers.splice(0, 1, member('bob'))
    await nextTick()
    expect(order(wrapper)).toEqual(['me:camera'])
    expect(m.store.detachVideoFromElement).toHaveBeenCalledWith('bob', bobVideo, 'camera')
    expect(m.store.detachVideoFromElement).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    wrapper = null
    expect(m.store.detachVideoFromElement).toHaveBeenCalledWith('me', meVideo, 'camera')
    expect(m.store.detachVideoFromElement).toHaveBeenCalledTimes(2)
  })

  it('does not re-attach a live element on stream counter ticks', async () => {
    m.store = makeStore(member('me'), [member('bob', { isVideoEnabled: true })], { connectionMode: 'p2p' })
    wrapper = await mountStrip()
    expect(m.store.attachVideoToElement).toHaveBeenCalledTimes(1)

    m.store.streamUpdateCounter++
    await nextTick()
    await nextTick()
    expect(m.store.attachVideoToElement).toHaveBeenCalledTimes(1)

    // Ended track: the next tick re-attaches.
    const video = wrapper.find('video').element as HTMLVideoElement
    video.srcObject = fakeStream('ended')
    m.store.streamUpdateCounter++
    await nextTick()
    await nextTick()
    expect(m.store.attachVideoToElement).toHaveBeenCalledTimes(2)
  })

  it('sizes each tile to its video and follows resolution changes', async () => {
    m.store = makeStore(member('me'), [member('bob', { isVideoEnabled: true })], { connectionMode: 'p2p' })
    wrapper = await mountStrip()
    const tile = () => wrapper!.find('.dock-tile[data-user-id="bob"]').element as HTMLElement
    const report = async (el: HTMLVideoElement, w: number, hgt: number, event: string) => {
      Object.defineProperty(el, 'videoWidth', { value: w, configurable: true })
      Object.defineProperty(el, 'videoHeight', { value: hgt, configurable: true })
      el.dispatchEvent(new Event(event))
      await nextTick()
    }

    // Unmeasured container: camera row cap, 16:9 until metadata.
    expect([tile().style.width, tile().style.height]).toEqual(['248px', '140px'])

    const video = wrapper.find('video').element as HTMLVideoElement
    await report(video, 720, 1280, 'loadedmetadata')
    expect([tile().style.width, tile().style.height]).toEqual(['78px', '140px'])

    await report(video, 640, 480, 'resize')
    expect(tile().style.width).toBe('186px')

    // A screen share raises the row cap for every tile.
    m.store.allUsers.push(member('carol', { isScreenSharing: true }))
    await nextTick()
    await nextTick()
    const share = wrapper.find('.dock-tile[data-user-id="carol"]').element as HTMLElement
    expect([share.style.width, share.style.height]).toEqual(['462px', '260px'])
    expect(tile().style.height).toBe('260px')
  })

  describe('mobile keyboard', () => {
    let viewport: EventTarget & { height: number }

    beforeEach(() => {
      viewport = Object.assign(new EventTarget(), { height: 800 })
      Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    })

    it('collapses while a text field has focus and restores after', async () => {
      m.mobile.value = true
      m.store = makeStore(member('me'), [member('bob', { isVideoEnabled: true })])
      wrapper = await mountStrip()
      expect(wrapper.find('.dock-video-strip').exists()).toBe(true)

      const composer = document.createElement('textarea')
      document.body.appendChild(composer)
      composer.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      await nextTick()
      expect(wrapper.find('.dock-video-strip').exists()).toBe(false)
      expect(wrapper.find('.strip-expand').exists()).toBe(false)
      expect(lastExpanded(wrapper)).toBe(false)

      composer.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
      await nextTick()
      expect(wrapper.find('.dock-video-strip').exists()).toBe(true)
      expect(lastExpanded(wrapper)).toBe(true)
      expect(m.storage.size).toBe(0)
    })

    it('collapses while the visual viewport is shrunk by the keyboard', async () => {
      m.mobile.value = true
      m.store = makeStore(member('me'), [member('bob', { isVideoEnabled: true })])
      wrapper = await mountStrip()

      viewport.height = 450
      viewport.dispatchEvent(new Event('resize'))
      await nextTick()
      expect(wrapper.find('.dock-video-strip').exists()).toBe(false)

      viewport.height = 800
      viewport.dispatchEvent(new Event('resize'))
      await nextTick()
      expect(wrapper.find('.dock-video-strip').exists()).toBe(true)
    })

    it('never attaches when mounted with the keyboard already up', async () => {
      m.mobile.value = true
      const composer = document.createElement('textarea')
      document.body.appendChild(composer)
      composer.focus()
      m.store = makeStore(member('me'), [member('bob', { isVideoEnabled: true })])
      wrapper = await mountStrip()

      expect(document.activeElement).toBe(composer)
      expect(wrapper.find('.dock-video-strip').exists()).toBe(false)
      expect(m.store.attachVideoToElement).not.toHaveBeenCalled()
    })

    it('stays open on desktop while typing', async () => {
      m.store = makeStore(member('me'), [member('bob', { isVideoEnabled: true })])
      wrapper = await mountStrip()

      const composer = document.createElement('textarea')
      document.body.appendChild(composer)
      composer.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      viewport.height = 450
      viewport.dispatchEvent(new Event('resize'))
      await nextTick()
      expect(wrapper.find('.dock-video-strip').exists()).toBe(true)
    })
  })
})
