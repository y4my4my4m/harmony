import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Play together across accounts: signing out closes the launcher, ends the running game's frame and
// connection and forgets the sessions of the account's conversations; an answer it was still waiting
// for reaches neither the next account's list nor its screen.

const h = vi.hoisted(() => ({
  getSessions: vi.fn(),
  startSession: vi.fn(),
  runtimes: [] as Array<{ destroyed: boolean }>,
}))

vi.mock('vue-toastification', () => ({ useToast: () => ({ info: vi.fn(), error: vi.fn() }) }))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key, locale: { value: 'en' } } } }))
vi.mock('@/services/downloads', () => ({ saveFile: vi.fn() }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => ({ isOverlayVisible: false }) }))
vi.mock('@/utils/avatarUtils', () => ({ getAvatarUrl: (url: string) => url }))
vi.mock('@/services/playTogether/frameSupport', () => ({ frameRefusal: () => null }))
vi.mock('@/services/playTogether/catalog', () => ({
  fetchCatalog: async () => [],
  fetchAppRows: async () => [],
  localizedApp: (app: { name: string }) => ({ name: app.name, description: '' }),
  mergeApps: () => [{ id: 'drawinphone', name: 'DrawinPhone', enabled: true, contexts: ['direct'] }],
}))
vi.mock('@/services/playTogether/sessions', async (load) => ({
  ...(await load<typeof import('@/services/playTogether/sessions')>()),
  getSessions: h.getSessions,
  startSession: h.startSession,
}))
vi.mock('@/services/playTogether/activityRuntime', () => ({
  ActivityRuntime: class {
    destroyed = false
    constructor() { h.runtimes.push(this) }
    start() {}
    setVisible() {}
    pushTheme() {}
    destroy() { this.destroyed = true }
  },
}))

import { usePlayTogetherStore } from '@/stores/playTogether'

const DM = { kind: 'conversation' as const, id: 'conv-a' }
const session = { id: 's1', app_id: 'drawinphone', app_name: 'DrawinPhone', context: 'direct', status: 'active', conversation_id: 'conv-a', members: [] } as any

beforeEach(() => {
  setActivePinia(createPinia())
  h.runtimes.length = 0
  h.getSessions.mockReset().mockResolvedValue([session])
  h.startSession.mockReset().mockResolvedValue({ session, existing: false })
})

describe('reset', () => {
  it('closes the launcher, ends the game and drops the sessions', async () => {
    const store = usePlayTogetherStore()
    store.openLauncher(DM, 'direct')
    await vi.waitFor(() => expect(store.sessionIn(DM)).toMatchObject({ id: 's1' }))
    await store.join(session)
    expect(store.joined).not.toBeNull()

    store.reset()
    expect(store.launcher).toBeNull()
    expect(store.joined).toBeNull()
    expect(h.runtimes).toEqual([expect.objectContaining({ destroyed: true })])
    expect(store.sessions).toEqual({})
    expect(store.view.status).toBe('connecting')
  })

  it('drops the sessions of a list still being read', async () => {
    const store = usePlayTogetherStore()
    let answer!: (list: unknown[]) => void
    h.getSessions.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const read = store.refresh(DM)
    store.reset()
    answer([session])
    await expect(read).resolves.toEqual([])
    expect(store.sessions).toEqual({})
  })

  it('opens no frame for a start still being answered', async () => {
    const store = usePlayTogetherStore()
    await store.loadApps()
    let answer!: (result: unknown) => void
    h.startSession.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const started = store.start('drawinphone', DM)
    store.reset()
    answer({ session, existing: false })
    await expect(started).resolves.toBe(false)
    expect(h.runtimes).toEqual([])
    expect(store.sessions).toEqual({})
  })

  it('does not read again the sessions a leave left behind', async () => {
    vi.useFakeTimers()
    try {
      const store = usePlayTogetherStore()
      await store.join(session)
      store.leave()
      const reads = h.getSessions.mock.calls.length
      store.reset()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(h.getSessions).toHaveBeenCalledTimes(reads)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('visible', () => {
  it('follows the app window, and stays on in the call\'s pop-out whatever that window is', async () => {
    const store = usePlayTogetherStore()
    store.registerSlot(document.createElement('div'))
    expect(store.visible).toBe(true)
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      expect(store.visible).toBe(false)
      store.inPopout = true
      expect(store.visible).toBe(true)
    } finally {
      state.mockRestore()
    }
  })
})
