import { describe, it, expect, vi, beforeEach } from 'vitest'

// Sounds play from buffers decoded when the theme loads: a play starts a buffer source and
// requests nothing. A context that starts suspended (no user activation yet) is resumed by the
// first pointer or key input, and a play waits on no other sound of the theme.

vi.mock('@/services/androidReleaseNotice', () => ({ isAndroidApp: () => false }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const started: string[] = []
const fetched: string[] = []
let fetchGate: Promise<void> = Promise.resolve()

class FakeBufferSource {
  buffer: { path: string } | null = null
  connect(node: unknown) { return node }
  start() { started.push(this.buffer!.path) }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state: 'suspended' | 'running' = 'suspended'
  destination = {}
  resumes = 0
  constructor() { FakeAudioContext.instances.push(this) }
  resume() {
    this.resumes++
    if (activated) this.state = 'running'
    return activated ? Promise.resolve() : new Promise<void>(() => {})
  }
  createBufferSource() { return new FakeBufferSource() }
  createGain() { return { gain: { value: 1 }, connect: (node: unknown) => node } }
  decodeAudioData(bytes: ArrayBuffer) { return Promise.resolve({ path: new TextDecoder().decode(bytes) }) }
}

let activated = false
vi.stubGlobal('AudioContext', FakeAudioContext)
vi.stubGlobal('fetch', vi.fn(async (path: string) => {
  fetched.push(path)
  await fetchGate
  return new Response(new TextEncoder().encode(path))
}))

const { audioThemeService } = await import('../AudioThemeService')

beforeEach(() => {
  started.length = 0
})

describe('notification sounds over Web Audio', () => {
  it('loads the theme without user activation and decodes its alert sounds', async () => {
    await audioThemeService.preloadTheme('default')
    expect(fetched).toContain('/assets/sounds/default/reaction.mp3')
    expect(fetched).toContain('/assets/sounds/default/click.mp3')
    expect(audioThemeService.getCacheInfo().paths).toContain('/assets/sounds/default/reaction.mp3')
    expect(audioThemeService.getCacheInfo().paths).not.toContain('/assets/sounds/default/click.mp3')
    expect(audioThemeService.canPlayNow()).toBe(false)
  })

  it('stays silent until the first input resumes the context', async () => {
    await audioThemeService.testAudio('reaction')
    expect(started).toEqual([])

    activated = true
    window.dispatchEvent(new Event('pointerdown'))
    await Promise.resolve()
    expect(audioThemeService.canPlayNow()).toBe(true)
  })

  it('plays a decoded sound with no request', async () => {
    const before = fetched.length
    await audioThemeService.testAudio('reaction')
    expect(started).toEqual(['/assets/sounds/default/reaction.mp3'])
    expect(fetched.length).toBe(before)
  })

  it('decodes a sound fetched ahead on first use, still with no request', async () => {
    const before = fetched.length
    await audioThemeService.testAudio('ui_click')
    expect(started).toEqual(['/assets/sounds/default/click.mp3'])
    expect(fetched.length).toBe(before)
  })

  it('drops a sound whose file has not arrived within a second, rather than play it late', async () => {
    vi.useFakeTimers()
    let open!: () => void
    fetchGate = new Promise<void>((resolve) => { open = resolve })
    audioThemeService.registerTheme({
      id: 'slow', name: 'Slow', description: '', author: '', version: '1', isBuiltIn: false,
      sounds: { mention: '/slow/mention.mp3' },
    })
    const playing = audioThemeService.playThemeFeedbackSound('slow')
    await vi.advanceTimersByTimeAsync(1100)
    await playing
    open()
    await vi.runAllTimersAsync()
    vi.useRealTimers()
    expect(started).toEqual([])
  })
})
