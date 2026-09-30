// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SOURCE = readFileSync(fileURLToPath(new URL('../../public/service-worker.js', import.meta.url)), 'utf8')
const ORIGIN = 'https://harmony.test'

// In-memory CacheStorage with the ignoreSearch matching the worker relies on.
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>()
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map())
    const store = stores.get(name)!
    const keyOf = (req: any) => (typeof req === 'string' ? req : req.url)
    return {
      match: async (req: any, opts?: { ignoreSearch?: boolean }) => {
        const key = keyOf(req)
        if (!opts?.ignoreSearch) return store.get(key)
        const base = key.split('?')[0]
        for (const [k, v] of store) if (k.split('?')[0] === base) return v
        return undefined
      },
      put: async (req: any, res: Response) => { store.set(keyOf(req), res) },
      delete: async (req: any) => store.delete(keyOf(req)),
      keys: async () => [...store.keys()].map(url => ({ url })),
    }
  }
  return { open, keys: async () => [...stores.keys()], delete: async (n: string) => stores.delete(n), match: async () => undefined }
}

function loadWorker(windows: Array<{ focused: boolean; url?: string }> = []) {
  const listeners = new Map<string, (event: any) => void>()
  const shown: Array<{ title: string; options: any }> = []
  const clientList = windows.map(w => ({
    url: w.url ?? `${ORIGIN}/chat`,
    focused: w.focused,
    focus: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn(),
  }))
  const self: any = {
    addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, fn),
    location: { origin: ORIGIN },
    registration: {
      scope: `${ORIGIN}/`,
      showNotification: vi.fn(async (title: string, options: any) => { shown.push({ title, options }) }),
      getNotifications: vi.fn(async () => []),
      pushManager: { subscribe: vi.fn() },
    },
    clients: {
      matchAll: vi.fn(async () => clientList),
      openWindow: vi.fn(async () => null),
      claim: vi.fn(),
    },
    skipWaiting: vi.fn(),
  }
  const sandbox: any = {
    self,
    caches: fakeCaches(),
    fetch: vi.fn(async () => new Response('{}')),
    navigator: {},
    console: { log() {}, warn() {}, error() {} },
    URL,
    Request,
    Response,
    indexedDB: undefined,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(SOURCE, sandbox)

  const dispatch = async (type: string, event: any) => {
    const pending: Promise<unknown>[] = []
    listeners.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) })
    await Promise.all(pending)
  }
  const push = (payload: any) => dispatch('push', { data: { json: () => payload, text: () => JSON.stringify(payload) } })
  const message = (data: any) => dispatch('message', { data, ports: [] })
  return { self, shown, clientList, dispatch, push, message }
}

const payload = (id: string) => ({
  title: 'ann sent you a message',
  body: 'hi',
  type: 'dm',
  tag: 'harmony-dm-conv-c1',
  data: { notification_id: id, url: '/dm/c1?messageId=m1', conversation_id: 'c1' },
})

describe('service worker notifications', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows a push once when the app already showed the same notification', async () => {
    const sw = loadWorker([{ focused: false }])
    await sw.message({ type: 'SHOW_NOTIFICATION', title: 'from app', options: { data: { notification_id: 'n1' } } })
    await sw.push(payload('n1'))
    expect(sw.shown).toHaveLength(1)
    expect(sw.shown[0].title).toBe('from app')
  })

  it('shows once when the push arrives first', async () => {
    const sw = loadWorker([])
    await sw.push(payload('n2'))
    await sw.message({ type: 'SHOW_NOTIFICATION', title: 'from app', options: { data: { notification_id: 'n2' } } })
    await sw.push(payload('n2'))
    expect(sw.shown).toHaveLength(1)
  })

  it('answers the page so it knows not to show the notification itself', async () => {
    const sw = loadWorker([])
    const port = { postMessage: vi.fn() }
    await sw.dispatch('message', {
      data: { type: 'SHOW_NOTIFICATION', title: 't', options: { data: { notification_id: 'ack' } } },
      ports: [port],
    })
    expect(port.postMessage).toHaveBeenCalledWith({ handled: true })
  })

  it('shows distinct notifications', async () => {
    const sw = loadWorker([])
    await sw.push(payload('a'))
    await sw.push(payload('b'))
    expect(sw.shown).toHaveLength(2)
  })

  it('stays silent while a window is focused', async () => {
    const sw = loadWorker([{ focused: true }])
    await sw.push(payload('n3'))
    expect(sw.shown).toHaveLength(0)
  })

  it('counts uncontrolled windows as the app', async () => {
    const sw = loadWorker([{ focused: true }])
    await sw.push(payload('n4'))
    expect(sw.self.clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true })
  })

  it('routes a click to the open window with the payload url', async () => {
    const sw = loadWorker([{ focused: false }])
    const notification = { data: payload('n5').data, close: vi.fn() }
    await sw.dispatch('notificationclick', { notification, action: '' })

    expect(sw.clientList[0].focus).toHaveBeenCalled()
    expect(sw.clientList[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'NAVIGATE_TO_NOTIFICATION',
      url: `${ORIGIN}/dm/c1?messageId=m1`,
    }))
  })

  it('opens a window at the route when none exists, and queues the read', async () => {
    const sw = loadWorker([])
    const notification = { data: { notification_id: 'n6', url: '/social/post/p1' }, close: vi.fn() }
    await sw.dispatch('notificationclick', { notification, action: '' })
    expect(sw.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/social/post/p1`)

    const port = { postMessage: vi.fn() }
    await sw.dispatch('message', { data: { type: 'TAKE_PENDING_READS' }, ports: [port] })
    expect(port.postMessage).toHaveBeenCalledWith({ ids: ['n6'] })

    const again = { postMessage: vi.fn() }
    await sw.dispatch('message', { data: { type: 'TAKE_PENDING_READS' }, ports: [again] })
    expect(again.postMessage).toHaveBeenCalledWith({ ids: [] })
  })

  it('never opens another origin from a payload url', async () => {
    const sw = loadWorker([])
    const notification = { data: { url: 'https://evil.example/x', conversation_id: 'c2' }, close: vi.fn() }
    await sw.dispatch('notificationclick', { notification, action: '' })
    expect(sw.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/dm/c2`)
  })

  it('closes notifications outside the kept set', async () => {
    const sw = loadWorker([])
    const keep = { data: { notification_id: 'keep' }, tag: 't1', close: vi.fn() }
    const drop = { data: { notification_id: 'drop' }, tag: 't2', close: vi.fn() }
    const legacy = { data: {}, tag: 't3', close: vi.fn() }
    sw.self.registration.getNotifications.mockResolvedValue([keep, drop, legacy])

    await sw.message({ type: 'DISMISS_NOTIFICATIONS', keepIds: ['keep'] })

    expect(keep.close).not.toHaveBeenCalled()
    expect(drop.close).toHaveBeenCalled()
    expect(legacy.close).not.toHaveBeenCalled()
  })
})
