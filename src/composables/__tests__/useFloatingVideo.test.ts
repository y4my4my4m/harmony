import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))

// Minimal IntersectionObserver: records observed targets and lets a test
// report a visibility ratio for one of them.
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

function makeVideoEmbed(parent: HTMLElement) {
  const container = document.createElement('div')
  container.className = 'video-container'
  const video = document.createElement('video')
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

describe('useFloatingVideo', () => {
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

  it('floats a playing video that leaves the viewport and leaves a placeholder', async () => {
    const { api, message, slot } = await setup()
    const { container, start } = makeVideoEmbed(message)
    api.registerVideo(container, { type: 'video', messageId: 'm1' })

    report(container, 0.1)
    expect(container.parentElement).toBe(message) // paused: stays

    start()
    report(container, 0.1)
    expect(container.parentElement).toBe(slot)
    expect(message.querySelector('.floating-video-placeholder')).not.toBeNull()
    expect(api.floatingMessageId.value).toBe('m1')
  })

  it('docks when the placeholder scrolls back into view and keeps playing', async () => {
    const { api, message } = await setup()
    const { container, video, start } = makeVideoEmbed(message)
    api.registerVideo(container, { type: 'video' })
    start()
    report(container, 0)

    const placeholder = message.querySelector('.floating-video-placeholder')!
    report(placeholder, 0.9)
    expect(container.parentElement).toBe(message)
    expect(message.querySelector('.floating-video-placeholder')).toBeNull()
    expect(video.pause).not.toHaveBeenCalled()
  })

  it('does not re-float a docked video until it has been seen again', async () => {
    const { api, message, player, slot } = await setup()
    const { container, start } = makeVideoEmbed(message)
    api.registerVideo(container, { type: 'video' })
    start()
    report(container, 0)
    player.dock({ scroll: true })

    report(container, 0) // still off-screen during the scroll
    expect(container.parentElement).toBe(message)

    report(container, 0.8)
    report(container, 0.1)
    expect(container.parentElement).toBe(slot)
  })

  it('closes the player when its owner unmounts', async () => {
    const { api, app, message, slot } = await setup()
    const { container, video, start } = makeVideoEmbed(message)
    const cleanup = api.registerVideo(container, { type: 'video' })
    start()
    report(container, 0)

    message.remove() // row unmounted; placeholder leaves with it
    cleanup()
    expect(video.pause).toHaveBeenCalled()
    expect(container.isConnected).toBe(false)
    expect(slot.childElementCount).toBe(0)
    expect(api.floatingMessageId.value).toBeNull()
    expect(app.isConnected).toBe(true)
  })

  it('closes the floating video when another video starts', async () => {
    const { api, message } = await setup()
    const first = makeVideoEmbed(message)
    const second = makeVideoEmbed(message)
    api.registerVideo(first.container, { type: 'video' })
    api.registerVideo(second.container, { type: 'video' })
    first.start()
    report(first.container, 0)

    second.start()
    api.notifyPlaybackStarted(second.video)
    expect(first.video.pause).toHaveBeenCalled()
    expect(first.container.parentElement).toBe(message)
  })

  it('docks without pausing when disabled, and stays docked', async () => {
    const { api, message } = await setup()
    const { container, video, start } = makeVideoEmbed(message)
    api.registerVideo(container, { type: 'video' })
    start()
    report(container, 0)

    api.setEnabled(false)
    expect(container.parentElement).toBe(message)
    expect(video.pause).not.toHaveBeenCalled()
    expect(localStorage.getItem('floatingVideoEnabled')).toBe('false')

    report(container, 0.8)
    report(container, 0)
    expect(container.parentElement).toBe(message)
  })

  it('ignores embeds rendered outside the app root', async () => {
    const { api, slot } = await setup()
    const overlay = document.createElement('div')
    document.body.appendChild(overlay)
    const { container, start } = makeVideoEmbed(overlay)
    api.registerVideo(container, { type: 'video' })
    start()
    report(container, 0)
    expect(container.parentElement).toBe(overlay)
    expect(slot.childElementCount).toBe(0)
  })

  it('restores the corner persisted for the session', async () => {
    sessionStorage.setItem('floatingVideoPlacement', JSON.stringify({ corner: 'top-left', longEdge: 0 }))
    const { player } = await setup()
    expect(player.corner.value).toBe('top-left')
  })
})
