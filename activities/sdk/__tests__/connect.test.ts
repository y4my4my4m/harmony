import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Which windows an activity hears. Docked, the app's window is the frame's parent. In a call's pop-out
// the parent is the pop-out and the app's window its opener, or no relation of it (Document
// Picture-in-Picture). A site that opened Harmony is an opener too: of the window the frame is docked in.

const APP = 'https://harmony.test'
const listeners: Array<(event: unknown) => void> = []
const parent = { opener: null as unknown, postMessage: vi.fn() }
let ancestors: string[] | undefined

const init = (id = 'host-1') => ({
  hp: 1, t: 'init', you: id, host: id, canEnd: false, locale: 'en', visible: true, state: null, clockOffset: 0,
  theme: { scheme: 'dark', accent: '#0EA5E9', reducedMotion: false },
  session: { id: 's1', appId: 'a', context: 'direct', startedBy: id, maxPlayers: 2, minPlayers: 1 },
  members: [{ id, name: id, username: id, joinedAt: 1, spectator: false, state: null }],
})

const say = (source: unknown, origin: string, data: unknown) => listeners.forEach((l) => l({ source, origin, data }))

async function connecting() {
  vi.resetModules()
  const { connect } = await import('../index')
  let room: any = null
  let error: any = null
  connect({ timeoutMs: 50 }).then((r) => { room = r }, (e) => { error = e })
  const settled = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    return room
  }
  return { settled, failed: async () => { await new Promise((resolve) => setTimeout(resolve, 80)); return error?.code ?? null } }
}

beforeEach(() => {
  listeners.length = 0
  parent.opener = null
  parent.postMessage.mockClear()
  ancestors = [APP]
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: any) => { if (type === 'message') listeners.push(listener) }) as any)
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as any)
  vi.stubGlobal('location', {
    origin: APP,
    get ancestorOrigins() { return ancestors },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('docked', () => {
  it('hears the window that embeds it', async () => {
    const { settled } = await connecting()
    say(parent, APP, init())
    expect((await settled())?.hostId).toBe('host-1')
  })

  it.each([
    ['the browser names the frame\'s ancestors', [APP]],
    ['it names none (Firefox)', undefined],
    ['the frame\'s referrer policy hides them', ['null']],
  ])('does not hear the site that opened the app, where %s', async (_where, named) => {
    ancestors = named
    const evil = { name: 'evil' }
    parent.opener = evil
    const { settled, failed } = await connecting()
    say(evil, 'https://evil.test', init('forged'))
    expect(await settled()).toBeNull()
    expect(await failed()).toBe('TIMEOUT')
  })

  it('a forged message after the session is not heard either', async () => {
    const evil = { name: 'evil' }
    parent.opener = evil
    const { settled } = await connecting()
    say(parent, APP, init())
    const room = await settled()
    const heard = vi.fn()
    room.on('message', heard)
    say(evil, 'https://evil.test', { hp: 1, t: 'message', from: 'host-1', data: 'forged' })
    say(evil, 'null', { hp: 1, t: 'message', from: 'host-1', data: 'forged' })
    expect(heard).not.toHaveBeenCalled()
    say(parent, APP, { hp: 1, t: 'message', from: 'host-1', data: 'said' })
    expect(heard).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'said', 'host-1')
  })

  it('does not hear an unrelated window, whatever its origin claims', async () => {
    const { settled } = await connecting()
    say({ name: 'other' }, 'https://evil.test', init('forged'))
    say(null, APP, init('forged'))
    say({ name: 'sandboxed' }, 'null', init('forged'))
    expect(await settled()).toBeNull()
  })
})

describe('in a call\'s pop-out', () => {
  it.each([
    ['the browser names the frame\'s ancestors', [APP]],
    ['it names none (Firefox)', undefined],
    ['the frame\'s referrer policy hides them', ['null']],
  ])('hears the app\'s window, the pop-out\'s opener, where %s', async (_where, named) => {
    ancestors = named
    const app = { name: 'app' }
    parent.opener = app
    const { settled } = await connecting()
    say(app, APP, init())
    expect((await settled())?.hostId).toBe('host-1')
    // What the activity says goes to the window that shows it, for the app's origin only.
    ;(await settled()).leave()
    expect(parent.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ t: 'leave' }), APP)
  })

  it('hears the app\'s window from a Document Picture-in-Picture window, which has no opener', async () => {
    const { settled } = await connecting()
    say({ name: 'app' }, APP, init())
    expect((await settled())?.hostId).toBe('host-1')
  })

  it('a native app\'s origin is the pop-out\'s, not the instance\'s that serves the frame', async () => {
    ancestors = ['http://tauri.localhost']
    const app = { name: 'app' }
    parent.opener = app
    const { settled } = await connecting()
    say(app, 'https://evil.test', init('forged'))
    say(app, 'http://tauri.localhost', init())
    expect((await settled())?.hostId).toBe('host-1')
  })
})
