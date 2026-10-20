import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'

// The main window's side of the floating dock: opening the window, the state it is sent,
// the commands it sends back, and closing with the call.

const h = vi.hoisted(() => ({
  store: null as any,
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => undefined),
  emitTo: vi.fn(async (_target: string, _event: string, _payload: unknown) => undefined),
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  desktop: true,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: h.emitTo,
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    h.listeners.set(event, cb)
    return () => h.listeners.delete(event)
  }),
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    innerPosition: async () => ({ x: 200, y: 100 }),
    scaleFactor: async () => 2,
  }),
}))
vi.mock('@/services/instanceConfig', () => ({ isTauriRuntime: () => h.desktop }))
vi.mock('@/utils/platform', () => ({ isMobileUserAgent: () => false }))
vi.mock('@/utils/appZoom', () => ({ nativeZoomFactor: () => 1.25 }))
vi.mock('@/services/userDataService', () => ({
  userDataService: { getUserProfile: (id: string) => ({ display_name: `Name ${id}`, avatar_url: null }) },
}))
vi.mock('@/utils/avatarUtils', () => ({ getAvatarUrl: () => '' }))
vi.mock('@/i18n', () => ({
  i18n: { global: { t: (key: string, named?: Record<string, unknown>) => (named && 'count' in named ? `${key}:${named.count}` : key) } },
}))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => h.store }))

import {
  buildDockState,
  closeFloatingDock,
  floatDock,
  floatingDockActive,
  onFloatingDockCommand,
  screenPointFromClient,
  clientPointFromLogical,
} from '../floatingDock'
import { DOCK_COMMAND_EVENT, DOCK_STATE_EVENT } from '@/overlay/floatingDockProtocol'

const testDeps = {
  t: (key: string, named?: Record<string, unknown>) => (named && 'count' in named ? `${key}:${named.count}` : key),
  profile: (id: string) => ({ name: `Name ${id}`, avatar: '/default_avatar.webp' }),
}

async function settle() {
  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(0)
}

function makeStore() {
  return reactive({
    isConnected: true,
    currentChannelName: 'lounge',
    dmOtherUserId: null as string | null,
    isEncrypted: true,
    speakLocked: false,
    deafenLocked: false,
    connectionState: 'connected',
    callStartTime: new Date(1000),
    localState: { userId: 'me', isMuted: false, isDeafened: false, audioLevel: 40 },
    allUsers: [{ userId: 'bob', isMuted: true, isDeafened: false, isSpeaking: false }],
    toggleMute: vi.fn(),
    toggleDeafen: vi.fn(),
    leaveVoiceChannel: vi.fn(),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  h.store = makeStore()
  h.desktop = true
  h.invoke.mockClear()
  h.emitTo.mockClear()
  h.listeners.clear()
})

afterEach(async () => {
  await closeFloatingDock()
  vi.useRealTimers()
})

describe('floating dock service', () => {
  it('describes the call for the dock window, translated', () => {
    const state = buildDockState(testDeps)
    expect(state.channelName).toBe('lounge')
    expect(state.participants.map((p) => [p.userId, p.name, p.speaking, p.muted])).toEqual([
      ['me', 'Name me', true, false],
      ['bob', 'Name bob', false, true],
    ])
    expect(state.encrypted).toBe(true)
    expect(state.startedAt).toBe(1000)
    expect(state.labels.inCall).toBe('voice.inCallCount:2')
    expect(state.labels.backToApp).toBe('voice.floatingDock.backToApp')
  })

  it('names a DM call after the other person', () => {
    h.store.dmOtherUserId = 'carol'
    expect(buildDockState(testDeps).channelName).toBe('Name carol')
  })

  it('opens the window, sends state, and resends on change', async () => {
    expect(await floatDock({ x: 10.4, y: 20.6 })).toBe(true)
    expect(h.invoke).toHaveBeenCalledWith('float_dock_open', { x: 10, y: 21 })
    expect(floatingDockActive.value).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    expect(h.emitTo).toHaveBeenLastCalledWith('dock', DOCK_STATE_EVENT, expect.objectContaining({ muted: false }))

    h.store.localState.isMuted = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(50)
    expect(h.emitTo).toHaveBeenLastCalledWith('dock', DOCK_STATE_EVENT, expect.objectContaining({ muted: true }))
  })

  it('runs the dock window commands', async () => {
    await floatDock({ x: 0, y: 0 })
    const command = h.listeners.get(DOCK_COMMAND_EVENT)!
    command({ payload: { type: 'mute' } })
    command({ payload: { type: 'deafen' } })
    command({ payload: { type: 'leave' } })
    expect(h.store.toggleMute).toHaveBeenCalledTimes(1)
    expect(h.store.toggleDeafen).toHaveBeenCalledTimes(1)
    expect(h.store.leaveVoiceChannel).toHaveBeenCalledTimes(1)
  })

  it('closes the window and hands redock and expand to the in-app dock', async () => {
    const seen: unknown[] = []
    const off = onFloatingDockCommand((c) => seen.push(c))
    await floatDock({ x: 0, y: 0 })
    h.listeners.get(DOCK_COMMAND_EVENT)!({ payload: { type: 'redock', at: { x: 5, y: 6 } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([{ type: 'redock', at: { x: 5, y: 6 } }])
    expect(floatingDockActive.value).toBe(false)
    expect(h.invoke).toHaveBeenCalledWith('float_dock_close')

    await floatDock({ x: 0, y: 0 })
    h.listeners.get(DOCK_COMMAND_EVENT)!({ payload: { type: 'expand' } })
    await settle()
    expect(h.invoke).toHaveBeenCalledWith('float_dock_focus_main')
    off()
  })

  it('closes with the call', async () => {
    await floatDock({ x: 0, y: 0 })
    h.store.isConnected = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    expect(floatingDockActive.value).toBe(false)
    expect(h.invoke).toHaveBeenCalledWith('float_dock_close')
  })

  it('is refused outside the desktop app', async () => {
    h.desktop = false
    expect(await floatDock({ x: 0, y: 0 })).toBe(false)
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('maps client px to logical screen px and back through the native zoom', async () => {
    // Content origin (200, 100) physical at scale 2 is (100, 50) logical; zoom 1.25.
    expect(await screenPointFromClient({ x: 40, y: -8 })).toEqual({ x: 150, y: 40 })
    expect(clientPointFromLogical({ x: 50, y: 25 })).toEqual({ x: 40, y: 20 })
  })
})
