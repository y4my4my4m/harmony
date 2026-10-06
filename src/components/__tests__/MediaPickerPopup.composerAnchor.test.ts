/**
 * MediaPickerPopup on mobile (<= 768px) with a docked composer: the picker's
 * bottom sits 8px above the composer's top edge, inset 8px from its sides, and
 * follows the composer and the visual viewport. Desktop keeps trigger-relative
 * positioning.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import MediaPickerPopup from '../MediaPickerPopup.vue'

const isMobile = ref(true)

vi.mock('@/composables/useLayoutState', () => ({
  useLayoutState: () => ({ isMobile }),
}))
vi.mock('@/composables/useElasticHorizontalScroll', async () => {
  const { ref: vueRef } = await import('vue')
  return {
    useElasticHorizontalScroll: () => ({ trackStyle: vueRef({}), measure: vi.fn(), onWheel: vi.fn() }),
  }
})
vi.mock('@/stores/useInstanceSettings', () => ({
  useInstanceSettingsStore: () => ({ gifClipsEnabled: false, gifMemesEnabled: false, gifAiEmojisEnabled: false }),
}))

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('div', { class: name }) }) }
}
vi.mock('@/components/GifPickerContent.vue', () => stub('GifPickerContent'))
vi.mock('@/components/EmojiPickerContent.vue', () => stub('EmojiPickerContent'))

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  targets: Element[] = []
  disconnected = false
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(target: Element) {
    this.targets.push(target)
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true
    this.targets = []
  }
  fire() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

type Rect = { top: number; left: number; width: number; height: number }

class FakeVisualViewport extends EventTarget {
  offsetTop = 0
  offsetLeft = 0
  width = 0
  height = 0
}

const domRect = (r: Rect) =>
  ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r }) as DOMRect

function element(rect: Rect) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const state = { rect }
  const spy = vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() => domRect(state.rect))
  return { el, state, spy }
}

let vv: FakeVisualViewport
const originals: Record<string, PropertyDescriptor | undefined> = {}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })
  vv.width = width
  vv.height = height
}

function box(wrapper: VueWrapper) {
  const s = (wrapper.element as HTMLElement).style
  return { left: s.left, top: s.top, width: s.width, height: s.height, maxHeight: s.maxHeight }
}

/** Bottom edge of the picker, px. */
function bottomOf(wrapper: VueWrapper) {
  const s = (wrapper.element as HTMLElement).style
  return parseFloat(s.top) + parseFloat(s.height)
}

function composerObserver(composer: HTMLElement) {
  return FakeResizeObserver.instances.find((o) => o.targets.includes(composer))
}

let wrapper: VueWrapper | null = null

async function open(props: { triggerElement?: HTMLElement; composerElement?: HTMLElement }) {
  wrapper = mount(MediaPickerPopup, {
    props: { ...props, position: 'above', initialTab: 'gifs', closePopup: vi.fn() },
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key } },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  isMobile.value = true
  FakeResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  for (const key of ['innerWidth', 'innerHeight', 'visualViewport']) {
    originals[key] = Object.getOwnPropertyDescriptor(window, key)
  }
  vv = new FakeVisualViewport()
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const [key, desc] of Object.entries(originals)) {
    if (desc) Object.defineProperty(window, key, desc)
    else delete (window as unknown as Record<string, unknown>)[key]
  }
})

describe('MediaPickerPopup mobile composer anchor', () => {
  it('sits above the composer top edge across its width, not above the trigger', async () => {
    setViewport(390, 844)
    // Five-line draft: the GIF button sits at the strip's foot, 100px below
    // the composer's top edge.
    const composer = element({ top: 700, left: 0, width: 390, height: 144 })
    const trigger = element({ top: 796, left: 300, width: 40, height: 40 })

    const w = await open({ triggerElement: trigger.el, composerElement: composer.el })

    expect(box(w)).toEqual({ left: '8px', top: '192px', width: '374px', height: '500px', maxHeight: '500px' })
    expect(bottomOf(w)).toBe(700 - 8)
    expect(w.classes()).toContain('media-picker-popup--composer')
  })

  it('fills the room between the top edge and the composer below the max height', async () => {
    setViewport(390, 600)
    const composer = element({ top: 456, left: 0, width: 390, height: 144 })

    const w = await open({ composerElement: composer.el })

    expect(box(w)).toMatchObject({ top: '8px', height: '440px' })
  })

  it('keeps clear of the top safe area', async () => {
    setViewport(390, 600)
    const composer = element({ top: 456, left: 0, width: 390, height: 144 })
    const w = await open({ composerElement: composer.el })

    ;(w.find('.safe-area-probe').element as HTMLElement).style.paddingTop = '47px'
    window.dispatchEvent(new Event('resize'))
    await flushPromises()

    expect(box(w)).toMatchObject({ top: '55px', height: '393px' })
  })

  it('follows the composer as it grows and shrinks', async () => {
    setViewport(390, 700)
    const composer = element({ top: 600, left: 0, width: 390, height: 100 })
    const w = await open({ composerElement: composer.el })
    expect(box(w)).toMatchObject({ top: '92px', height: '500px' })

    const observer = composerObserver(composer.el)
    expect(observer).toBeDefined()

    composer.state.rect = { top: 500, left: 0, width: 390, height: 200 }
    observer!.fire()
    await flushPromises()
    expect(box(w)).toMatchObject({ top: '8px', height: '484px' })
    expect(bottomOf(w)).toBe(500 - 8)

    composer.state.rect = { top: 640, left: 0, width: 390, height: 60 }
    observer!.fire()
    await flushPromises()
    expect(box(w)).toMatchObject({ top: '132px', height: '500px' })
    expect(bottomOf(w)).toBe(640 - 8)
  })

  it('stays above the keyboard when only the visual viewport shrinks', async () => {
    setViewport(390, 844)
    const composer = element({ top: 700, left: 0, width: 390, height: 144 })
    const w = await open({ composerElement: composer.el })

    // Keyboard covers the composer; layout viewport unchanged.
    vv.height = 400
    vv.dispatchEvent(new Event('resize'))
    await flushPromises()

    expect(box(w)).toMatchObject({ top: '8px', height: '384px' })
  })

  it('tracks the composer when the keyboard resizes the layout viewport', async () => {
    setViewport(390, 844)
    const composer = element({ top: 700, left: 0, width: 390, height: 144 })
    const w = await open({ composerElement: composer.el })

    setViewport(390, 444)
    composer.state.rect = { top: 300, left: 0, width: 390, height: 144 }
    window.dispatchEvent(new Event('resize'))
    await flushPromises()

    expect(box(w)).toMatchObject({ top: '8px', height: '284px' })
  })

  it('keeps a minimum height and still leaves the composer uncovered', async () => {
    setViewport(390, 300)
    const composer = element({ top: 180, left: 0, width: 390, height: 120 })

    const w = await open({ composerElement: composer.el })

    expect(box(w)).toMatchObject({ top: '-28px', height: '200px' })
    expect(bottomOf(w)).toBe(180 - 8)
  })

  it('releases the observer and viewport listeners on close', async () => {
    setViewport(390, 844)
    const composer = element({ top: 700, left: 0, width: 390, height: 144 })
    const removeSpy = vi.spyOn(vv, 'removeEventListener')
    const w = await open({ composerElement: composer.el })
    const observer = composerObserver(composer.el)!

    w.unmount()
    wrapper = null

    expect(observer.disconnected).toBe(true)
    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function))
  })

  it('without a composer keeps the trigger-anchored mobile layout', async () => {
    setViewport(390, 844)
    const trigger = element({ top: 796, left: 300, width: 40, height: 40 })

    const w = await open({ triggerElement: trigger.el })

    expect(w.classes()).not.toContain('media-picker-popup--composer')
    expect(box(w)).toMatchObject({ left: '12px', top: '268px', width: '366px', maxHeight: '500px' })
  })
})

describe('MediaPickerPopup desktop', () => {
  it('positions from the trigger and ignores the composer', async () => {
    isMobile.value = false
    setViewport(1440, 900)
    const composer = element({ top: 780, left: 300, width: 1140, height: 120 })
    const trigger = element({ top: 800, left: 900, width: 40, height: 40 })

    const w = await open({ triggerElement: trigger.el, composerElement: composer.el })

    // calculatePopupPosition 'above': x = 900 + 20 - 400 / 2, y = 800 - 500 - 8.
    expect(box(w)).toEqual({ left: '720px', top: '292px', width: '', height: '', maxHeight: '' })
    expect(w.classes()).not.toContain('media-picker-popup--composer')
    expect(composerObserver(composer.el)).toBeUndefined()
    expect(composer.spy).not.toHaveBeenCalled()
  })
})
