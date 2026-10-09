import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))

// Records observed targets; report() delivers a visibility ratio for one.
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

function report(target: Element, ratio: number) {
  for (const io of FakeIntersectionObserver.instances) {
    if (io.targets.has(target)) io.report(target, ratio)
  }
}

function makeVideoEmbed(parent: HTMLElement, src = '') {
  const container = document.createElement('div')
  const video = document.createElement('video')
  if (src) video.setAttribute('src', src)
  let paused = true
  Object.defineProperty(video, 'paused', { get: () => paused, configurable: true })
  video.play = vi.fn(async () => { paused = false })
  video.pause = vi.fn(() => { paused = true })
  container.appendChild(video)
  parent.appendChild(container)
  return { container, video, start: () => { paused = false } }
}

async function setup() {
  vi.resetModules()
  const mod = await import('../useFloatingVideo')
  const app = document.createElement('div')
  app.id = 'app'
  const message = document.createElement('div')
  app.appendChild(message)
  document.body.appendChild(app)

  const slot = document.createElement('div')
  const probe = document.createElement('div')
  document.body.append(slot, probe)
  const player = mod.useFloatingVideoPlayer()
  player.attachHost(slot, probe)

  return { mod, api: mod.useFloatingVideo(), player, app, message, slot }
}

describe('useFloatingVideo popOut', () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    localStorage.clear()
    sessionStorage.clear()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('floats a paused video in full view', async () => {
    const { api, message, slot } = await setup()
    const { container, video } = makeVideoEmbed(message)
    api.registerVideo(container, { type: 'video', messageId: 'm1' })
    report(container, 1)

    expect(api.popOut(container)).toBe(true)
    expect(container.parentElement).toBe(slot)
    expect(message.querySelector('.floating-video-placeholder')).not.toBeNull()
    expect(api.floatingMessageId.value).toBe('m1')
    expect(video.pause).not.toHaveBeenCalled()
  })

  it('does not dock while the placeholder stays in view', async () => {
    const { api, player, message, slot } = await setup()
    const { container } = makeVideoEmbed(message)
    api.registerVideo(container, { type: 'video' })
    api.popOut(container)

    const placeholder = message.querySelector('.floating-video-placeholder')!
    report(placeholder, 1)
    report(placeholder, 0.8)
    report(placeholder, 0.3)
    report(placeholder, 0.9)
    expect(container.parentElement).toBe(slot)
    expect(player.current.value?.manual).toBe(true)
  })

  it('docks once the placeholder has left the view and come back', async () => {
    const { api, player, message, slot } = await setup()
    const { container, video } = makeVideoEmbed(message)
    api.registerVideo(container, { type: 'video' })
    api.popOut(container)
    const placeholder = message.querySelector('.floating-video-placeholder')!

    report(placeholder, 1)
    report(placeholder, 0.1)
    expect(container.parentElement).toBe(slot)
    expect(player.current.value?.manual).toBe(false)

    report(placeholder, 0.9)
    expect(container.parentElement).toBe(message)
    expect(message.querySelector('.floating-video-placeholder')).toBeNull()
    expect(video.pause).not.toHaveBeenCalled()
  })

  it('docks from the placeholder button while in view', async () => {
    const { api, message } = await setup()
    const { container } = makeVideoEmbed(message)
    api.registerVideo(container, { type: 'video' })
    api.popOut(container)

    message.querySelector<HTMLButtonElement>('.floating-video-placeholder')!.click()
    expect(container.parentElement).toBe(message)
    expect(api.floatingMessageId.value).toBeNull()
  })

  it('pops out with auto-float disabled', async () => {
    const { api, message, slot } = await setup()
    api.setEnabled(false)
    const { container } = makeVideoEmbed(message)
    api.registerVideo(container, { type: 'video' })

    expect(api.popOut(container)).toBe(true)
    expect(container.parentElement).toBe(slot)
  })

  it('closes the floating video it replaces', async () => {
    const { api, message, slot } = await setup()
    const first = makeVideoEmbed(message)
    const second = makeVideoEmbed(message)
    api.registerVideo(first.container, { type: 'video', messageId: 'm1' })
    api.registerVideo(second.container, { type: 'video', messageId: 'm2' })
    first.start()
    report(first.container, 0)
    expect(first.container.parentElement).toBe(slot)

    api.popOut(second.container)
    expect(first.video.pause).toHaveBeenCalled()
    expect(first.container.parentElement).toBe(message)
    expect(second.container.parentElement).toBe(slot)
    expect(slot.childElementCount).toBe(1)
    expect(api.floatingMessageId.value).toBe('m2')
  })

  it('keeps an auto-floated video on the visibility rules', async () => {
    const { api, player, message } = await setup()
    const { container, start } = makeVideoEmbed(message)
    api.registerVideo(container, { type: 'video' })
    start()
    report(container, 0)
    expect(player.current.value?.manual).toBe(false)

    report(message.querySelector('.floating-video-placeholder')!, 0.9)
    expect(container.parentElement).toBe(message)
  })

  it('refuses unregistered embeds and embeds outside the app root', async () => {
    const { api, message, slot } = await setup()
    const unregistered = makeVideoEmbed(message)
    expect(api.popOut(unregistered.container)).toBe(false)

    const overlay = document.createElement('div')
    document.body.appendChild(overlay)
    const teleported = makeVideoEmbed(overlay)
    api.registerVideo(teleported.container, { type: 'video' })
    expect(api.canPopOut(teleported.container)).toBe(false)
    expect(api.popOut(teleported.container)).toBe(false)
    expect(slot.childElementCount).toBe(0)
  })

  it('refuses a YouTube embed with no iframe', async () => {
    const { api, message, slot } = await setup()
    const collapsed = document.createElement('div')
    message.appendChild(collapsed)
    api.registerVideo(collapsed, { type: 'youtube', sourceUrl: 'https://youtu.be/x' })
    expect(api.popOut(collapsed)).toBe(false)
    expect(slot.childElementCount).toBe(0)
  })

  it('docks into a re-mounted source after a return, though popped out', async () => {
    vi.useFakeTimers()
    try {
      const { api, player, app, message, slot } = await setup()
      const first = makeVideoEmbed(message, '/clip.webm')
      const cleanup = api.registerVideo(first.container, { type: 'video', messageId: 'm1' })
      api.popOut(first.container)
      message.remove()
      cleanup()
      expect(player.returnToSource()).not.toBeNull()

      const remounted = document.createElement('div')
      app.appendChild(remounted)
      const second = makeVideoEmbed(remounted, '/clip.webm')
      api.registerVideo(second.container, { type: 'video', messageId: 'm1' })
      const placeholder = remounted.querySelector<HTMLElement>('.floating-video-placeholder')!
      placeholder.scrollIntoView = vi.fn()
      placeholder.getBoundingClientRect = () => ({ top: 100, bottom: 300, height: 200 }) as DOMRect

      report(placeholder, 0.9)
      vi.advanceTimersByTime(500)
      expect(first.container.parentElement).not.toBe(slot)
      expect(second.container.querySelector('video')).toBe(first.video)
    } finally {
      vi.useRealTimers()
    }
  })
})
