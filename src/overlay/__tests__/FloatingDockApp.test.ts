import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

// The floating dock window: renders the state the main window sends, sends its controls
// back as commands, drags natively, sizes the window to itself, and asks to go back into the
// app when dropped on it.

const h = vi.hoisted(() => ({
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  emit: vi.fn(async (_event: string, _payload?: unknown) => undefined),
  moved: null as null | (() => void),
  startDragging: vi.fn(async () => undefined),
  setSize: vi.fn(async (_size: unknown) => undefined),
  self: { pos: { x: 0, y: 0 }, size: { width: 360, height: 56 } },
  main: { pos: { x: 100, y: 100 }, size: { width: 1200, height: 800 }, inner: { x: 100, y: 130 }, scale: 1, visible: true },
}))

vi.mock('@tauri-apps/api/event', () => ({
  emit: h.emit,
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    h.listeners.set(event, cb)
    return () => h.listeners.delete(event)
  }),
}))
vi.mock('@tauri-apps/api/window', () => ({
  LogicalSize: class { constructor(public width: number, public height: number) {} },
  getCurrentWindow: () => ({
    startDragging: h.startDragging,
    setSize: h.setSize,
    onMoved: async (cb: () => void) => { h.moved = cb; return () => { h.moved = null } },
    outerPosition: async () => h.self.pos,
    outerSize: async () => h.self.size,
  }),
  Window: {
    getByLabel: async () => ({
      isVisible: async () => h.main.visible,
      isMinimized: async () => false,
      outerPosition: async () => h.main.pos,
      outerSize: async () => h.main.size,
      innerPosition: async () => h.main.inner,
      scaleFactor: async () => h.main.scale,
    }),
  },
}))
vi.mock('@/components/common/Icon.vue', () => ({ __esModule: true, default: { name: 'Icon', props: ['name'], template: '<i :data-icon="name" />' } }))
vi.mock('@/components/icons/Headphones.vue', () => ({ __esModule: true, default: { name: 'Headphones', render: () => null } }))

import FloatingDockApp from '../FloatingDockApp.vue'
import { DOCK_COMMAND_EVENT, DOCK_READY_EVENT, DOCK_STATE_EVENT, type DockState } from '../floatingDockProtocol'

const state = (over: Partial<DockState> = {}): DockState => ({
  channelName: 'lounge',
  selfId: 'me',
  participants: [
    { userId: 'me', name: 'Me', avatar: '/me.png', speaking: true, muted: false, deafened: false },
    { userId: 'bob', name: 'Bob', avatar: '/bob.png', speaking: false, muted: true, deafened: false },
  ],
  muted: false,
  deafened: false,
  speakLocked: false,
  deafenLocked: false,
  encrypted: true,
  reconnecting: false,
  startedAt: null,
  labels: {
    mute: 'Mute', unmute: 'Unmute', deafen: 'Deafen', undeafen: 'Undeafen', backToApp: 'Back to the app',
    leave: 'Leave voice', participants: 'Participants', inCall: '2 in call', dragHint: 'Drag to move', reconnecting: 'Reconnecting',
  },
  html: { className: 'theme-dark', style: '--accent: red', attributes: { 'data-theme': 'dark' } },
  ...over,
})

let wrapper: VueWrapper | null = null

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  h.listeners.clear()
  h.emit.mockClear()
  h.startDragging.mockClear()
  h.self.pos = { x: 0, y: 0 }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mountDock(initial: DockState = state()) {
  wrapper = mount(FloatingDockApp, { attachTo: document.body })
  await flushPromises()
  h.listeners.get(DOCK_STATE_EVENT)!({ payload: initial })
  await flushPromises()
  return wrapper
}

const sent = () => h.emit.mock.calls.filter(([event]) => event === DOCK_COMMAND_EVENT).map(([, payload]) => payload)

describe('FloatingDockApp', () => {
  it('asks for the state once mounted, and renders it with the main window theme', async () => {
    const w = await mountDock()
    expect(h.emit).toHaveBeenCalledWith(DOCK_READY_EVENT)
    expect(w.text()).toContain('lounge')
    expect(w.find('[data-icon="shield-check"]').exists()).toBe(true)
    // Only Me is speaking.
    expect(w.findAll('.fd-speaker')).toHaveLength(1)
    const html = document.documentElement
    expect(html.classList.contains('theme-dark')).toBe(true)
    expect(html.classList.contains('floating-dock-document')).toBe(true)
    expect(html.getAttribute('data-theme')).toBe('dark')
    expect(html.style.getPropertyValue('--accent').trim()).toBe('red')
  })

  it('sends its controls back as commands, with their states', async () => {
    const w = await mountDock(state({ muted: true }))
    const mute = w.find('[data-testid="floating-dock-mute"]')
    expect(mute.attributes('aria-pressed')).toBe('true')
    expect(mute.attributes('title')).toBe('Unmute')
    await mute.trigger('click')
    await w.find('[data-testid="floating-dock-deafen"]').trigger('click')
    await w.find('[data-testid="floating-dock-back"]').trigger('click')
    await w.find('[data-testid="floating-dock-leave"]').trigger('click')
    await flushPromises()
    expect(sent()).toEqual([{ type: 'mute' }, { type: 'deafen' }, { type: 'expand' }, { type: 'leave' }])
  })

  it('lists the participants on demand', async () => {
    const w = await mountDock()
    const toggle = w.find('[data-testid="floating-dock-participants"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(w.find('[data-testid="floating-dock-row-bob"]').find('[data-icon="mic-off"]').exists()).toBe(true)
  })

  it('drags natively from its info area, and double-click goes back into the app', async () => {
    const w = await mountDock()
    const info = w.find('[data-testid="floating-dock-drag"]')
    await info.trigger('mousedown', { button: 0 })
    await flushPromises()
    expect(h.startDragging).toHaveBeenCalledTimes(1)
    await info.trigger('mousedown', { button: 2 })
    await flushPromises()
    expect(h.startDragging).toHaveBeenCalledTimes(1)
    await info.trigger('dblclick')
    await flushPromises()
    expect(sent()).toEqual([{ type: 'redock' }])
  })

  it('goes back into the app when dropped on it, once the move settles', async () => {
    await mountDock()
    // Off the app: nothing.
    h.self.pos = { x: 1500, y: 100 }
    h.moved?.()
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()
    expect(sent()).toEqual([])

    // Centre over the app: back in, at its offset from the app's content origin.
    h.self.pos = { x: 400, y: 330 }
    h.moved?.()
    await vi.advanceTimersByTimeAsync(200)
    h.moved?.()
    await vi.advanceTimersByTimeAsync(200)
    expect(sent()).toEqual([])
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(sent()).toEqual([{ type: 'redock', at: { x: 300, y: 200 } }])
  })

  it('finds a drag-and-drop onto the app by sampling its position when no move event arrives', async () => {
    const w = await mountDock()
    await w.find('[data-testid="floating-dock-drag"]').trigger('mousedown', { button: 0 })
    await flushPromises()
    // The window manager moves the window; no Moved event reaches the page.
    h.self.pos = { x: 300, y: 250 }
    await vi.advanceTimersByTimeAsync(200)
    h.self.pos = { x: 400, y: 330 }
    await vi.advanceTimersByTimeAsync(300)
    expect(sent()).toEqual([])
    await vi.advanceTimersByTimeAsync(600)
    await flushPromises()
    expect(sent()).toEqual([{ type: 'redock', at: { x: 300, y: 200 } }])
  })

  it('sends one redock however many paths report the drop', async () => {
    const w = await mountDock()
    await w.find('[data-testid="floating-dock-drag"]').trigger('mousedown', { button: 0 })
    await flushPromises()
    h.self.pos = { x: 400, y: 330 }
    h.moved?.()
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    expect(sent()).toEqual([{ type: 'redock', at: { x: 300, y: 200 } }])
  })

  it('stays floating when the app window is hidden', async () => {
    h.main.visible = false
    await mountDock()
    h.self.pos = { x: 400, y: 330 }
    h.moved?.()
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()
    expect(sent()).toEqual([])
    h.main.visible = true
  })
})
