/**
 * Gallery videos register with the floating player: they float when scrolled
 * away while playing, and each video tile pops out on request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  targets = new Set<Element>()
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
  }
  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear() }
  takeRecords() { return [] }
  report(target: Element, ratio: number) {
    const entry = {
      target,
      intersectionRatio: ratio,
      isIntersecting: ratio > 0,
      rootBounds: null,
      intersectionRect: { height: 0 },
    } as unknown as IntersectionObserverEntry
    this.callback([entry], this as unknown as IntersectionObserver)
  }
}

function observed(target: Element): boolean {
  return FakeIntersectionObserver.instances.some(io => io.targets.has(target))
}

function report(target: Element, ratio: number) {
  for (const io of FakeIntersectionObserver.instances) {
    if (io.targets.has(target)) io.report(target, ratio)
  }
}

const PARTS = [
  { type: 'file', fileType: 'video', url: 'https://cdn.example/a.mp4' },
  { type: 'file', fileType: 'image', url: 'https://cdn.example/b.png' },
  { type: 'file', fileType: 'video', url: 'https://cdn.example/c.webm' },
]

async function setup() {
  vi.resetModules()
  const floating = await import('@/composables/useFloatingVideo')
  const { default: MessageMediaGallery } = await import('../MessageMediaGallery.vue')

  const app = document.createElement('div')
  app.id = 'app'
  document.body.appendChild(app)
  const slot = document.createElement('div')
  const probe = document.createElement('div')
  document.body.append(slot, probe)
  floating.useFloatingVideoPlayer().attachHost(slot, probe)

  const wrapper = mount(MessageMediaGallery, {
    props: { parts: PARTS as never, imageLoaded: {}, messageId: 'm1' },
    attachTo: app,
  })
  await flushPromises()
  const frames = wrapper.findAll('.message-media-gallery__frame').map(f => f.element as HTMLElement)
  return { floating, wrapper, frames, slot }
}

describe('MessageMediaGallery floating videos', () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('registers each video tile and none of the images', async () => {
    const { wrapper, frames } = await setup()
    expect(frames).toHaveLength(3)
    expect(observed(frames[0])).toBe(true)
    expect(observed(frames[1])).toBe(false)
    expect(observed(frames[2])).toBe(true)
    expect(wrapper.findAll('.floating-video-popout')).toHaveLength(2)
    wrapper.unmount()
  })

  it('floats a playing video tile that scrolls away', async () => {
    const { wrapper, frames, slot } = await setup()
    const video = frames[0].querySelector('video')!
    Object.defineProperty(video, 'paused', { get: () => false, configurable: true })

    report(frames[0], 0)
    expect(frames[0].parentElement).toBe(slot)
    wrapper.unmount()
  })

  it('pops a video tile out from its button', async () => {
    const { floating, wrapper, frames, slot } = await setup()
    await wrapper.findAll('.floating-video-popout')[1].trigger('click')
    expect(frames[2].parentElement).toBe(slot)
    expect(floating.useFloatingVideo().floatingMessageId.value).toBe('m1')
    wrapper.unmount()
  })

  it('unregisters its videos on unmount', async () => {
    const { wrapper, frames } = await setup()
    wrapper.unmount()
    expect(observed(frames[0])).toBe(false)
    expect(observed(frames[2])).toBe(false)
  })

  it('registers a video added after mount', async () => {
    const { wrapper } = await setup()
    await wrapper.setProps({
      parts: [...PARTS, { type: 'file', fileType: 'video', url: 'https://cdn.example/d.mp4' }] as never,
    })
    await flushPromises()
    const frames = wrapper.findAll('.message-media-gallery__frame').map(f => f.element as HTMLElement)
    expect(frames).toHaveLength(4)
    expect(observed(frames[3])).toBe(true)
    expect(wrapper.findAll('.floating-video-popout')).toHaveLength(3)
    wrapper.unmount()
  })
})
