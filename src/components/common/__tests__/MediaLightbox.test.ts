/**
 * MediaLightbox and its host: images, videos and audio in one list, previous and next,
 * the inline player's position carried in and handed back, the fullscreen control only
 * where fullscreen exists, touch gestures, and openLightbox rendering through
 * MediaLightboxHost in the opener's portal container.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'

vi.mock('@/utils/downloadMedia', () => ({
  downloadMediaFromUrl: vi.fn(async () => {}),
  filenameFromUrl: (url: string, fallback = 'download') => url.split('/').pop() || fallback,
}))

import MediaLightbox, { type LightboxItem } from '../MediaLightbox.vue'
import MediaLightboxHost from '../MediaLightboxHost.vue'
import { closeLightbox, openLightbox, useLightbox } from '@/composables/useLightbox'
import { providePortalTarget } from '@/composables/usePortalTarget'
import { downloadMediaFromUrl } from '@/utils/downloadMedia'

enableAutoUnmount(afterEach)

// happy-dom has no media pipeline: time, duration and play state are stubbed per element.
function stubMedia(media: HTMLMediaElement, duration = 60, time = 0, playing = false) {
  let paused = !playing
  let current = time
  Object.defineProperty(media, 'duration', { configurable: true, get: () => duration })
  Object.defineProperty(media, 'paused', { configurable: true, get: () => paused })
  Object.defineProperty(media, 'ended', { configurable: true, get: () => false })
  Object.defineProperty(media, 'currentTime', {
    configurable: true,
    get: () => current,
    set: (v: number) => { current = v },
  })
  media.play = vi.fn(() => { paused = false; return Promise.resolve() })
  media.pause = vi.fn(() => { paused = true })
  return media
}

const ITEMS: LightboxItem[] = [
  { src: 'https://x.test/a.png', type: 'image', alt: 'A harbour', name: 'a.png' },
  { src: 'https://x.test/b.webm', type: 'video', poster: 'https://x.test/b.jpg', name: 'b.webm' },
  { src: 'https://x.test/c.ogg', type: 'audio', name: 'c.ogg' },
]

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const button = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((b) => b.getAttribute('aria-label') === label)

function mountViewer(props: Record<string, unknown> = {}) {
  return mount(MediaLightbox, {
    props: { visible: true, imgs: ITEMS, index: 0, 'onUpdate:index': () => {}, ...props },
    attachTo: document.body,
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  closeLightbox()
  delete (document as unknown as Record<string, unknown>).fullscreenEnabled
})

describe('MediaLightbox', () => {
  it('steps through images, video and audio of one list', async () => {
    const wrapper = mountViewer()
    wrapper.setProps({ 'onUpdate:index': (i: number) => wrapper.setProps({ index: i }) })
    await nextTick()
    expect(dialog()?.getAttribute('aria-label')).toBe('a11y.lightbox.label, a11y.lightbox.position')
    expect(document.querySelector('img.media-image')?.getAttribute('alt')).toBe('A harbour')
    expect(button('a11y.lightbox.previous')).toBeUndefined()

    button('a11y.lightbox.next')!.click()
    await flushPromises()
    const video = document.querySelector<HTMLVideoElement>('video.media-video')!
    expect(video.getAttribute('src')).toBe('https://x.test/b.webm')
    expect(video.getAttribute('poster')).toBe('https://x.test/b.jpg')
    expect(document.querySelector('[data-testid="video-controls"]')).not.toBeNull()

    button('a11y.lightbox.next')!.click()
    await flushPromises()
    expect(document.querySelector('.media-audio-frame .audio-name')?.textContent).toBe('c.ogg')
    expect(document.querySelector('video.media-audio-element')?.getAttribute('src')).toBe('https://x.test/c.ogg')
    expect(button('a11y.lightbox.next')).toBeUndefined()
  })

  it('takes over the inline player: starts at its time, keeps it playing, hands the position back', async () => {
    const origin = stubMedia(document.createElement('video'), 60, 12, true)
    document.body.appendChild(origin)
    const wrapper = mountViewer({ imgs: [ITEMS[1]], origin })
    await flushPromises()
    expect(origin.pause).toHaveBeenCalled()

    const video = stubMedia(document.querySelector<HTMLVideoElement>('video.media-video')!, 60)
    video.dispatchEvent(new Event('loadedmetadata'))
    expect(video.currentTime).toBe(12)
    expect(video.play).toHaveBeenCalled()

    video.currentTime = 31
    button('common.close')!.click()
    await flushPromises()
    expect(wrapper.emitted('hide')).toHaveLength(1)
    expect(origin.currentTime).toBe(31)
  })

  it('leaves a paused origin paused', async () => {
    const origin = stubMedia(document.createElement('video'), 60, 5, false)
    document.body.appendChild(origin)
    mountViewer({ imgs: [ITEMS[1]], origin })
    await flushPromises()
    const video = stubMedia(document.querySelector<HTMLVideoElement>('video.media-video')!, 60)
    video.dispatchEvent(new Event('loadedmetadata'))
    expect(video.currentTime).toBe(5)
    expect(video.play).not.toHaveBeenCalled()
  })

  it('shows the fullscreen control only where fullscreen exists, and fills the screen with the viewer', async () => {
    mountViewer()
    await flushPromises()
    expect(document.querySelector('[data-testid="lightbox-fullscreen"]')).toBeNull()

    Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true })
    const overlay = document.querySelector<HTMLElement>('.media-lightbox-overlay')!
    overlay.requestFullscreen = vi.fn(async () => {}) as HTMLElement['requestFullscreen']
    document.dispatchEvent(new Event('fullscreenchange'))
    await flushPromises()
    const control = document.querySelector<HTMLButtonElement>('[data-testid="lightbox-fullscreen"]')!
    expect(control.getAttribute('aria-label')).toBe('videoPlayer.fullscreen')
    control.click()
    expect(overlay.requestFullscreen).toHaveBeenCalled()
  })

  it('downloads the current item under its name when asked to', async () => {
    mountViewer({ download: true })
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-testid="lightbox-download"]')!.click()
    expect(downloadMediaFromUrl).toHaveBeenCalledWith('https://x.test/a.png', 'a.png')
  })

  it('has no download button by default', async () => {
    mountViewer()
    await flushPromises()
    expect(document.querySelector('[data-testid="lightbox-download"]')).toBeNull()
  })

  it('zooms an image from the toolbar and resets on the next item', async () => {
    const wrapper = mountViewer()
    wrapper.setProps({ 'onUpdate:index': (i: number) => wrapper.setProps({ index: i }) })
    await flushPromises()
    button('a11y.lightbox.zoomIn')!.click()
    await nextTick()
    expect(document.querySelector<HTMLElement>('img.media-image')!.style.transform).toContain('scale(1.25)')
    button('a11y.lightbox.next')!.click()
    await flushPromises()
    button('a11y.lightbox.previous')!.click()
    await flushPromises()
    expect(document.querySelector<HTMLElement>('img.media-image')!.style.transform).toContain('scale(1)')
  })
})

describe('openLightbox through MediaLightboxHost', () => {
  it('renders the requested list at its start index and closes', async () => {
    mount(MediaLightboxHost, { attachTo: document.body })
    openLightbox(
      [
        { url: 'https://x.test/a.png', type: 'image', name: 'a.png' },
        { url: 'https://x.test/b.webm', type: 'video', name: 'b.webm', poster: 'https://x.test/b.jpg' },
      ],
      1,
    )
    await flushPromises()
    expect(document.querySelector('video.media-video')?.getAttribute('src')).toBe('https://x.test/b.webm')
    expect(document.querySelector('.lightbox-name')?.textContent).toBe('b.webm')
    expect(document.querySelector('[data-testid="lightbox-download"]')).not.toBeNull()
    button('common.close')!.click()
    await flushPromises()
    expect(dialog()).toBeNull()
  })
})

describe('MediaLightbox touch gestures', () => {
  const stage = () => document.querySelector<HTMLElement>('.lightbox-stage')!
  const pointer = (type: string, id: number, x: number, y: number, target: EventTarget = window) =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, pointerType: 'touch', clientX: x, clientY: y }))

  function mountStepping(index: number) {
    const wrapper = mountViewer({ index })
    const steps: number[] = []
    wrapper.setProps({ 'onUpdate:index': (i: number) => { steps.push(i); wrapper.setProps({ index: i }) } })
    return { wrapper, steps }
  }

  it('never swipes or closes with two fingers on a video', async () => {
    const { wrapper, steps } = mountStepping(1)
    await flushPromises()
    pointer('pointerdown', 1, 200, 300, stage())
    pointer('pointerdown', 2, 230, 300, stage())
    pointer('pointermove', 1, 190, 300)
    pointer('pointermove', 2, 430, 300)
    pointer('pointerup', 1, 190, 300)
    pointer('pointerup', 2, 430, 300)
    await flushPromises()

    pointer('pointerdown', 1, 200, 100, stage())
    pointer('pointerdown', 2, 200, 130, stage())
    pointer('pointermove', 1, 200, 110)
    pointer('pointermove', 2, 200, 500)
    pointer('pointerup', 1, 200, 110)
    pointer('pointerup', 2, 200, 500)
    await flushPromises()
    expect(steps).toEqual([])
    expect(wrapper.emitted('hide')).toBeUndefined()
  })

  it("leaves a sideways drag on the video's native controls to the video", async () => {
    const { steps } = mountStepping(1)
    await flushPromises()
    pointer('pointerdown', 1, 300, 300, document.querySelector('video.media-video')!)
    pointer('pointermove', 1, 100, 300)
    pointer('pointerup', 1, 100, 300)
    await flushPromises()
    expect(steps).toEqual([])
  })

  it('closes on one tap beside the media after a swipe', async () => {
    const { wrapper, steps } = mountStepping(0)
    await flushPromises()
    pointer('pointerdown', 1, 300, 300, stage())
    pointer('pointermove', 1, 100, 300)
    pointer('pointerup', 1, 100, 300)
    await flushPromises()
    expect(steps).toEqual([1])

    // A touch swipe is followed by no click; the tap's own click closes.
    pointer('pointerdown', 1, 5, 5, stage())
    pointer('pointerup', 1, 5, 5)
    stage().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }))
    await flushPromises()
    expect(wrapper.emitted('hide')).toHaveLength(1)
  })
})

describe('the viewer in the portal container of its opener', () => {
  const viewerRoot = () => document.querySelector<HTMLElement>('[data-testid="media-viewer"]')
  const ITEM = [{ url: 'https://x.test/a.png', type: 'image' as const, name: 'a.png' }]

  // A subtree under a portal container, as the call view provides its .call-portals.
  function mountOpener(container: () => HTMLElement | null) {
    let open!: ReturnType<typeof useLightbox>['open']
    const Opener = defineComponent({
      setup() {
        open = useLightbox().open
        return () => null
      },
    })
    const Layer = defineComponent({
      setup() {
        providePortalTarget(container)
        return () => h(Opener)
      },
    })
    mount(Layer, { attachTo: document.body })
    return open
  }

  it('mounts in the container of the subtree that opened it', async () => {
    const portals = document.body.appendChild(document.createElement('div'))
    mount(MediaLightboxHost, { attachTo: document.body })
    mountOpener(() => portals)(ITEM)
    await flushPromises()
    expect(portals.contains(viewerRoot())).toBe(true)
  })

  it('moves to <body> when the container goes away', async () => {
    const portals = ref<HTMLElement | null>(document.body.appendChild(document.createElement('div')))
    mount(MediaLightboxHost, { attachTo: document.body })
    const container = portals.value!
    mountOpener(() => portals.value)(ITEM)
    await flushPromises()
    expect(container.contains(viewerRoot())).toBe(true)
    portals.value = null
    await flushPromises()
    expect(viewerRoot()?.isConnected).toBe(true)
    expect(container.contains(viewerRoot())).toBe(false)
  })

  it('swipes in a container of another window, as the call pop-out is', async () => {
    const frame = document.body.appendChild(document.createElement('iframe'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const portals = frame.contentDocument!.body.appendChild(frame.contentDocument!.createElement('div'))
    mount(MediaLightboxHost, { attachTo: document.body })
    mountOpener(() => portals)(ITEM.concat({ url: 'https://x.test/b.png', type: 'image', name: 'b.png' }))
    await flushPromises()
    const stage = portals.querySelector<HTMLElement>('.lightbox-stage')!
    const touch = (type: string, x: number) =>
      stage.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'touch', clientX: x, clientY: 300 }))
    touch('pointerdown', 300)
    touch('pointermove', 100)
    touch('pointerup', 100)
    await flushPromises()
    expect(portals.querySelector('.lightbox-name')?.textContent).toBe('b.png')
  })

  it('mounts on <body> by default, or in the target the options name', async () => {
    const portals = document.body.appendChild(document.createElement('div'))
    mount(MediaLightboxHost, { attachTo: document.body })
    openLightbox(ITEM)
    await flushPromises()
    expect(viewerRoot()?.isConnected).toBe(true)
    expect(portals.contains(viewerRoot())).toBe(false)
    openLightbox(ITEM, 0, { target: portals })
    await flushPromises()
    expect(portals.contains(viewerRoot())).toBe(true)
  })
})
