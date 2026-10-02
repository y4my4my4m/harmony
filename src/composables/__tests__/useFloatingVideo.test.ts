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

function makeVideoEmbed(parent: HTMLElement, src = '') {
  const container = document.createElement('div')
  container.className = 'video-container'
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

  it('keeps playing when its owner unmounts', async () => {
    const { api, player, message, slot } = await setup()
    const { container, video, start } = makeVideoEmbed(message, '/clip.webm')
    const cleanup = api.registerVideo(container, { type: 'video', messageId: 'm1' })
    start()
    report(container, 0)

    message.remove() // route change; the placeholder leaves with the row
    cleanup()
    expect(video.pause).not.toHaveBeenCalled()
    expect(container.parentElement).toBe(slot)
    expect(api.floatingMessageId.value).toBe('m1')
    expect(player.current.value?.orphaned).toBe(true)
    expect(player.current.value?.placeholder).toBeNull()
    expect(player.canDock.value).toBe(false)
  })

  it('docks into a re-mounted source of the same media, moving the playing node', async () => {
    vi.useFakeTimers()
    try {
      const { api, app, message, slot } = await setup()
      const first = makeVideoEmbed(message, '/clip.webm')
      const cleanup = api.registerVideo(first.container, { type: 'video', messageId: 'm1' })
      first.start()
      report(first.container, 0)
      message.remove()
      cleanup()

      const remounted = document.createElement('div')
      app.appendChild(remounted)
      const second = makeVideoEmbed(remounted, '/clip.webm')
      api.registerVideo(second.container, { type: 'video', messageId: 'm1' })

      const placeholder = remounted.querySelector<HTMLElement>('.floating-video-placeholder')!
      expect(placeholder).not.toBeNull()
      expect(second.container.style.display).toBe('none')
      expect(first.container.parentElement).toBe(slot)

      placeholder.getBoundingClientRect = () => ({ top: 100, bottom: 300, height: 200 }) as DOMRect
      report(placeholder, 0.9)
      expect(first.container.parentElement).toBe(slot) // waits for the dwell
      vi.advanceTimersByTime(500)

      expect(second.container.style.display).toBe('')
      expect(second.container.querySelector('video')).toBe(first.video)
      expect(second.video.isConnected).toBe(false)
      expect(first.container.isConnected).toBe(false)
      expect(remounted.querySelector('.floating-video-placeholder')).toBeNull()
      expect(first.video.pause).not.toHaveBeenCalled()
      expect(api.floatingMessageId.value).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not dock into a re-mounted source that scrolls away within the dwell', async () => {
    vi.useFakeTimers()
    try {
      const { api, app, message, slot } = await setup()
      const first = makeVideoEmbed(message, '/clip.webm')
      const cleanup = api.registerVideo(first.container, { type: 'video', messageId: 'm1' })
      first.start()
      report(first.container, 0)
      message.remove()
      cleanup()

      const remounted = document.createElement('div')
      app.appendChild(remounted)
      const second = makeVideoEmbed(remounted, '/clip.webm')
      api.registerVideo(second.container, { type: 'video', messageId: 'm1' })
      const placeholder = remounted.querySelector<HTMLElement>('.floating-video-placeholder')!

      report(placeholder, 0.9)
      report(placeholder, 0) // the chat jumps to its newest message
      vi.advanceTimersByTime(500)
      expect(first.container.parentElement).toBe(slot)
      expect(second.container.style.display).toBe('none')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not adopt a registration for other media or another message', async () => {
    const { api, app, message } = await setup()
    const first = makeVideoEmbed(message, '/clip.webm')
    const cleanup = api.registerVideo(first.container, { type: 'video', messageId: 'm1' })
    first.start()
    report(first.container, 0)
    message.remove()
    cleanup()

    const other = document.createElement('div')
    app.appendChild(other)
    const sameMessageOtherClip = makeVideoEmbed(other, '/other.webm')
    const otherMessage = makeVideoEmbed(other, '/clip.webm')
    api.registerVideo(sameMessageOtherClip.container, { type: 'video', messageId: 'm1' })
    api.registerVideo(otherMessage.container, { type: 'video', messageId: 'm2' })
    expect(other.querySelector('.floating-video-placeholder')).toBeNull()
    expect(sameMessageOtherClip.container.style.display).toBe('')
    expect(otherMessage.container.style.display).toBe('')
  })

  it('releases a re-mounted source that unmounts before the video docks', async () => {
    const { api, player, app, message, slot } = await setup()
    const first = makeVideoEmbed(message, '/clip.webm')
    const cleanupFirst = api.registerVideo(first.container, { type: 'video', messageId: 'm1' })
    first.start()
    report(first.container, 0)
    message.remove()
    cleanupFirst()

    const remounted = document.createElement('div')
    app.appendChild(remounted)
    const second = makeVideoEmbed(remounted, '/clip.webm')
    const cleanupSecond = api.registerVideo(second.container, { type: 'video', messageId: 'm1' })
    cleanupSecond()

    expect(remounted.querySelector('.floating-video-placeholder')).toBeNull()
    expect(second.container.style.display).toBe('')
    expect(first.container.parentElement).toBe(slot)
    expect(player.current.value?.target).toBeNull()
    expect(player.current.value?.orphaned).toBe(true)
  })

  it('closing a video with no mounted source pauses and removes it', async () => {
    const { api, player, message, slot } = await setup()
    const { container, video, start } = makeVideoEmbed(message, '/clip.webm')
    const cleanup = api.registerVideo(container, { type: 'video', messageId: 'm1' })
    start()
    report(container, 0)
    message.remove()
    cleanup()

    player.close()
    expect(video.pause).toHaveBeenCalled()
    expect(container.isConnected).toBe(false)
    expect(slot.childElementCount).toBe(0)
    expect(api.floatingMessageId.value).toBeNull()
  })

  it('closes the video of a deleted message', async () => {
    const { mod, api, message } = await setup()
    const { container, video, start } = makeVideoEmbed(message, '/clip.webm')
    api.registerVideo(container, { type: 'video', messageId: 'm1' })
    start()
    report(container, 0)

    mod.releaseFloatingVideo('m2')
    expect(api.floatingMessageId.value).toBe('m1')
    mod.releaseFloatingVideo('m1')
    expect(video.pause).toHaveBeenCalled()
    expect(api.floatingMessageId.value).toBeNull()
  })

  it('returns the source path when the source is not mounted, and docks when it is', async () => {
    window.history.replaceState(null, '', '/chat/s1/c1?x=1')
    const { mod, api, player, message } = await setup()
    const { container, start } = makeVideoEmbed(message, '/clip.webm')
    const cleanup = api.registerVideo(container, { type: 'video', messageId: 'm1' })
    start()
    report(container, 0)
    window.history.replaceState(null, '', '/social/local')

    message.remove()
    cleanup()
    expect(player.returnToSource()).toBe('/chat/s1/c1?x=1')
    expect(mod.floatingReturnTarget()).toBe('m1')
  })

  it('after a return, docks into the re-mounted source once part of it shows', async () => {
    vi.useFakeTimers()
    try {
      const { api, player, app, message, slot } = await setup()
      const first = makeVideoEmbed(message, '/clip.webm')
      const cleanup = api.registerVideo(first.container, { type: 'video', messageId: 'm1' })
      first.start()
      report(first.container, 0)
      message.remove()
      cleanup()
      expect(player.returnToSource()).not.toBeNull()

      const remounted = document.createElement('div')
      app.appendChild(remounted)
      const second = makeVideoEmbed(remounted, '/clip.webm')
      api.registerVideo(second.container, { type: 'video', messageId: 'm1' })
      const placeholder = remounted.querySelector<HTMLElement>('.floating-video-placeholder')!
      placeholder.scrollIntoView = vi.fn()

      // A message near the top of a channel: a third of the placeholder fits above the composer.
      placeholder.getBoundingClientRect = () => ({ top: window.innerHeight - 100, bottom: window.innerHeight + 200, height: 300 }) as DOMRect
      report(placeholder, 0.33)
      vi.advanceTimersByTime(500)
      expect(first.container.parentElement).not.toBe(slot)
      expect(second.container.querySelector('video')).toBe(first.video)
    } finally {
      vi.useRealTimers()
    }
  })

  it('docks on return while the source is mounted', async () => {
    const { mod, api, player, message } = await setup()
    const { container, start } = makeVideoEmbed(message, '/clip.webm')
    container.scrollIntoView = vi.fn()
    api.registerVideo(container, { type: 'video', messageId: 'm1' })
    start()
    report(container, 0)

    expect(player.returnToSource()).toBeNull()
    expect(container.parentElement).toBe(message)
    expect(mod.floatingReturnTarget()).toBeNull()
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

  it('resumes a YouTube iframe that a move reloaded at its last reported time', async () => {
    const { api, message, slot } = await setup()
    const embed = document.createElement('div')
    const iframe = document.createElement('iframe')
    const posted: string[] = []
    const playerWindow = { postMessage: (data: string) => posted.push(data) }
    Object.defineProperty(iframe, 'contentWindow', { get: () => playerWindow })
    embed.appendChild(iframe)
    message.appendChild(embed)
    api.registerVideo(embed, { type: 'youtube', messageId: 'm1', sourceUrl: 'https://youtu.be/x' })

    const fromPlayer = (data: unknown) => {
      const event = new MessageEvent('message', { data: JSON.stringify(data), origin: 'https://www.youtube.com' })
      Object.defineProperty(event, 'source', { get: () => playerWindow })
      window.dispatchEvent(event)
    }
    fromPlayer({ event: 'infoDelivery', info: { currentTime: 42.5, playerState: 1 } })
    embed.dataset.isPlaying = 'true'

    report(embed, 0) // happy-dom has no moveBefore: the move reloads the iframe
    expect(embed.parentElement).toBe(slot)
    iframe.dispatchEvent(new Event('load'))
    expect(posted.map(p => JSON.parse(p).event)).toContain('listening')

    fromPlayer({ event: 'onReady' })
    const commands = posted.map(p => JSON.parse(p)).filter(m => m.event === 'command')
    expect(commands).toEqual([
      { event: 'command', func: 'seekTo', args: [42.5, true] },
      { event: 'command', func: 'playVideo', args: [] },
    ])
  })

  it('restores the corner persisted for the session', async () => {
    sessionStorage.setItem('floatingVideoPlacement', JSON.stringify({ corner: 'top-left', longEdge: 0 }))
    const { player } = await setup()
    expect(player.corner.value).toBe('top-left')
  })
})
