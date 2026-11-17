import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayFrame } from '../../../../activities/sdk/protocol'

const sent: unknown[] = []
let handlers: { frame: (f: RelayFrame) => void; status: (s: string) => void; clock: (n: number) => void; final: (r: unknown) => void }

vi.mock('../relayConnection', () => ({
  RelayConnection: class {
    constructor(_session: string, h: typeof handlers) {
      handlers = h
    }
    start() {}
    stop() {}
    send(frame: unknown) {
      sent.push(frame)
      return true
    }
  },
}))

import { ActivityRuntime, SAVE_INTERVAL_MS, SAVE_MAX_PER_SESSION, type RuntimeView } from '../activityRuntime'
import type { ActivitySession } from '../sessions'

const ALICE = 'a1'
const BOB = 'b2'

function member(id: string, joinedAt: number) {
  return { id, name: id.toUpperCase(), username: id, avatarUrl: null, joinedAt, spectator: false, state: null }
}

const welcome = (host = ALICE): RelayFrame => ({
  op: 'welcome',
  you: member(ALICE, 1),
  session: { id: 's1', appId: 'drawinphone', context: 'direct', startedBy: ALICE, maxPlayers: 16, minPlayers: 2 },
  members: [member(ALICE, 1), member(BOB, 2)],
  host,
  state: { phase: 'lobby' },
  store: host === ALICE ? { k: 1 } : undefined,
  canEnd: true,
  serverTime: Date.now(),
})

let frame: { contentWindow: { postMessage: (msg: Record<string, unknown>) => void } }
let posted: Array<Record<string, unknown>>
let runtime: InstanceType<typeof ActivityRuntime>
let view: RuntimeView

function fromFrame(data: unknown, source: unknown = frame.contentWindow) {
  const event = new MessageEvent('message', { data })
  Object.defineProperty(event, 'source', { value: source })
  window.dispatchEvent(event)
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Makes the frame stand-in the focused element, as a click inside the frame does. */
function focusFrame(focused: boolean) {
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => (focused ? frame : document.body) })
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])

beforeEach(() => {
  sent.length = 0
  posted = []
  // happy-dom loads no frame documents: a stand-in window receives what the runtime posts.
  frame = { contentWindow: { postMessage: (msg: Record<string, unknown>) => { posted.push(msg) } } }
  view = { status: 'connecting', members: [], hostId: null, you: null, canEnd: false, final: null, frameReady: false, escaped: false }
  runtime = new ActivityRuntime({ id: 's1' } as ActivitySession, () => null, view, {
    locale: () => 'en',
    theme: () => ({ scheme: 'dark', accent: '#0EA5E9', reducedMotion: false }),
    visible: () => true,
    notify: vi.fn(),
    leave: vi.fn(),
    save: vi.fn(async () => true),
  })
  runtime.start()
  runtime.attachFrame(frame as unknown as HTMLIFrameElement)
})

afterEach(() => {
  runtime.destroy()
  delete (document as unknown as Record<string, unknown>).activeElement
  vi.useRealTimers()
})

describe('ActivityRuntime', () => {
  it('sends init once both the frame is ready and the relay welcomed', async () => {
    fromFrame({ hp: 1, t: 'ready', sdk: '1.0.0' })
    await flush()
    expect(posted.filter((m) => m.t === 'init')).toHaveLength(0)
    handlers.frame(welcome())
    await flush()
    const init = posted.find((m) => m.t === 'init')!
    expect(init).toMatchObject({ you: ALICE, host: ALICE, state: { phase: 'lobby' }, store: { k: 1 }, canEnd: true, locale: 'en' })
    expect((init.members as Array<{ id: string }>).map((m) => m.id)).toEqual([ALICE, BOB])
    expect(view.members.map((m) => m.id)).toEqual([ALICE, BOB])
  })

  it('leaves the store out of init for a member that does not host', async () => {
    handlers.frame(welcome(BOB))
    fromFrame({ hp: 1, t: 'ready', sdk: '1.0.0' })
    await flush()
    expect(posted.find((m) => m.t === 'init')).not.toHaveProperty('store')
  })

  it('ignores messages from any other window', async () => {
    handlers.frame(welcome())
    fromFrame({ hp: 1, t: 'send', data: 'x' }, window)
    fromFrame({ hp: 2, t: 'send', data: 'x' })
    fromFrame('send')
    await flush()
    expect(sent).toEqual([])
  })

  it('forwards sends, state and store writes of the host to the relay', async () => {
    handlers.frame(welcome())
    fromFrame({ hp: 1, t: 'send', data: { a: 1 }, to: 'host' })
    fromFrame({ hp: 1, t: 'state', state: { phase: 'draw' } })
    fromFrame({ hp: 1, t: 'store', key: 'chain', value: [1, 2] })
    fromFrame({ hp: 1, t: 'store', key: 'chain' })
    expect(sent).toEqual([
      { op: 'send', data: { a: 1 }, to: 'host' },
      { op: 'state', state: { phase: 'draw' } },
      { op: 'store', key: 'chain', value: [1, 2] },
      { op: 'store', key: 'chain' },
    ])
  })

  it('refuses state from a member that does not host, and oversized payloads', async () => {
    handlers.frame(welcome(BOB))
    fromFrame({ hp: 1, t: 'ready', sdk: '1.0.0' })
    await flush()
    posted.length = 0
    fromFrame({ hp: 1, t: 'state', state: { phase: 'mine' } })
    fromFrame({ hp: 1, t: 'send', data: 'x'.repeat(300 * 1024) })
    fromFrame({ hp: 1, t: 'send', data: 1, to: { evil: true } })
    await flush()
    expect(sent).toEqual([])
    expect(posted.filter((m) => m.t === 'error').map((m) => m.code)).toEqual(['NOT_HOST', 'TOO_LARGE'])
  })

  it('keeps relay frames in order, members before their messages', async () => {
    handlers.frame(welcome())
    fromFrame({ hp: 1, t: 'ready', sdk: '1.0.0' })
    handlers.frame({ op: 'join', member: member('c3', 3) })
    handlers.frame({ op: 'message', from: 'c3', data: 'hi' })
    await flush()
    await flush()
    expect(posted.map((m) => m.t)).toEqual(['init', 'join', 'message'])
  })

  it('hands a reloaded frame the store it received as the new host', async () => {
    handlers.frame(welcome(BOB))
    handlers.frame({ op: 'host', id: ALICE, store: { round: 4 } })
    fromFrame({ hp: 1, t: 'store', key: 'extra', value: true })
    runtime.frameReloaded()
    fromFrame({ hp: 1, t: 'ready', sdk: '1.0.0' })
    await flush()
    await flush()
    expect(posted.filter((m) => m.t === 'init').at(-1)).toMatchObject({ host: ALICE, store: { round: 4, extra: true } })
  })

  it('sends resync, not init, after a reconnect', async () => {
    fromFrame({ hp: 1, t: 'ready', sdk: '1.0.0' })
    handlers.frame(welcome())
    await flush()
    handlers.frame({ ...welcome(), state: { phase: 'reveal' } } as RelayFrame)
    await flush()
    await flush()
    expect(posted.map((m) => m.t)).toEqual(['init', 'resync'])
    expect(posted[1]).toMatchObject({ state: { phase: 'reveal' } })
  })

  it('rate-limits a flood from the frame', async () => {
    handlers.frame(welcome())
    fromFrame({ hp: 1, t: 'ready', sdk: '1.0.0' })
    for (let i = 0; i < 200; i++) fromFrame({ hp: 1, t: 'me', state: i })
    expect(sent.length).toBeLessThanOrEqual(121)
    expect(posted.some((m) => m.t === 'error' && m.code === 'RATE_LIMITED')).toBe(true)
  })

  it('saves only images, through the client', async () => {
    const save = vi.fn(async () => true)
    runtime.destroy()
    runtime = new ActivityRuntime({ id: 's1' } as ActivitySession, () => null, view, {
      locale: () => 'en', theme: () => ({ scheme: 'dark', accent: '#000', reducedMotion: false }), visible: () => true,
      notify: vi.fn(), leave: vi.fn(), save,
    })
    runtime.start()
    runtime.attachFrame(frame as unknown as HTMLIFrameElement)
    fromFrame({ hp: 1, t: 'ready', sdk: '1.0.0' })
    focusFrame(true)
    vi.useFakeTimers({ toFake: ['Date'] })
    fromFrame({ hp: 1, t: 'save', id: 1, blob: new Blob(['x'], { type: 'text/html' }), name: 'a.html' })
    fromFrame({ hp: 1, t: 'save', id: 2, blob: new Blob(['@echo off and more bytes'], { type: 'image/png' }), name: 'update.bat' })
    vi.advanceTimersByTime(SAVE_INTERVAL_MS)
    fromFrame({ hp: 1, t: 'save', id: 3, blob: new Blob([PNG], { type: 'image/png' }), name: '../chain.bat' })
    for (let i = 0; i < 5; i++) await flush()
    expect(save).toHaveBeenCalledTimes(1)
    expect((save.mock.calls[0] as unknown[])[1]).toBe('_chain.png')
    expect(posted.filter((m) => m.t === 'saved').sort((a, b) => Number(a.id) - Number(b.id))).toEqual([
      { hp: 1, t: 'saved', id: 1, ok: false },
      { hp: 1, t: 'saved', id: 2, ok: false },
      { hp: 1, t: 'saved', id: 3, ok: true },
    ])
  })

  it('saves only while the frame has focus, spaced and counted', async () => {
    const save = vi.fn(async () => true)
    runtime.destroy()
    runtime = new ActivityRuntime({ id: 's1' } as ActivitySession, () => null, view, {
      locale: () => 'en', theme: () => ({ scheme: 'dark', accent: '#000', reducedMotion: false }), visible: () => true,
      notify: vi.fn(), leave: vi.fn(), save,
    })
    runtime.start()
    runtime.attachFrame(frame as unknown as HTMLIFrameElement)
    fromFrame({ hp: 1, t: 'ready', sdk: '1.0.0' })
    vi.useFakeTimers({ toFake: ['Date'] })
    const ask = async (id: number) => {
      fromFrame({ hp: 1, t: 'save', id, blob: new Blob([PNG], { type: 'image/png' }), name: 'page' })
      for (let i = 0; i < 5; i++) await flush()
      return posted.find((m) => m.t === 'saved' && m.id === id)?.ok
    }

    focusFrame(false)
    expect(await ask(1)).toBe(false)
    focusFrame(true)
    expect(await ask(2)).toBe(true)
    expect(await ask(3)).toBe(false)
    vi.advanceTimersByTime(SAVE_INTERVAL_MS)
    expect(await ask(4)).toBe(true)
    for (let id = 5; id < 5 + SAVE_MAX_PER_SESSION; id++) {
      vi.advanceTimersByTime(SAVE_INTERVAL_MS)
      await ask(id)
    }
    expect(save).toHaveBeenCalledTimes(SAVE_MAX_PER_SESSION)
    vi.advanceTimersByTime(SAVE_INTERVAL_MS)
    expect(await ask(100)).toBe(false)
  })

  it('posts nothing to a frame that has not reported ready', async () => {
    handlers.frame(welcome())
    handlers.frame({ op: 'message', from: BOB, data: 'early' })
    await flush()
    expect(posted).toEqual([])
  })

  it('stops talking to a frame that leaves its document', async () => {
    handlers.frame(welcome())
    fromFrame({ hp: 1, t: 'ready', sdk: '1.0.0' })
    await flush()
    fromFrame({ hp: 1, t: 'gone' })
    expect(view.escaped).toBe(true)
    posted.length = 0
    handlers.frame({ op: 'message', from: BOB, data: 'after' })
    fromFrame({ hp: 1, t: 'ready', sdk: '1.0.0' })
    fromFrame({ hp: 1, t: 'send', data: 'from elsewhere' })
    await flush()
    expect(posted).toEqual([])
    expect(sent).toEqual([])
  })
})
