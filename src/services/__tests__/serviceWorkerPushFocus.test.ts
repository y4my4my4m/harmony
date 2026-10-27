// @vitest-environment node
// public/service-worker.js push handler: a focused window shows a notification itself from the
// realtime event, so the worker shows none; the Settings test push has no realtime event and is
// sent from the focused window, so it is shown regardless.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const source = fs.readFileSync(path.resolve(__dirname, '../../../public/service-worker.js'), 'utf8')

function load(windows: Array<{ focused: boolean }>) {
  const handlers: Record<string, (event: any) => void> = {}
  const showNotification = vi.fn(async (_title: string, _options: unknown) => {})
  const context = vm.createContext({
    self: {
      addEventListener: (type: string, fn: (event: any) => void) => { handlers[type] = fn },
      location: { origin: 'https://app.test' },
      registration: { scope: 'https://app.test/', showNotification, getNotifications: async () => [] },
      clients: {
        claim: async () => {},
        matchAll: async () => windows.map((w) => ({ ...w, url: 'https://app.test/settings/notifications' })),
      },
    },
    navigator: {},
    caches: {
      open: async () => ({ match: async () => undefined, put: async () => {}, keys: async () => [], delete: async () => true }),
      match: async () => undefined,
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async () => new Response(''),
    Response, Request, URL, Headers, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
  })
  vm.runInContext(source, context)
  return { handlers, showNotification }
}

async function push(handlers: Record<string, (event: any) => void>, payload: unknown) {
  let done: Promise<unknown> = Promise.resolve()
  handlers.push({ data: { json: () => payload, text: () => JSON.stringify(payload) }, waitUntil: (p: Promise<unknown>) => { done = p } })
  await done
}

const testPush = {
  title: 'Test notification',
  body: 'Push notifications are working.',
  type: 'test',
  tag: 'harmony-test-1',
  data: { test: true, url: '/' },
}
const dm = {
  title: 'Alice sent you a message',
  body: 'hi',
  type: 'dm',
  tag: 'harmony-dm-conv-c1',
  data: { notification_id: 'n1', type: 'dm', url: '/dm/c1', conversation_id: 'c1' },
}

describe('service worker push while a window is focused', () => {
  it('shows the Settings test push', async () => {
    const { handlers, showNotification } = load([{ focused: true }])
    await push(handlers, testPush)
    expect(showNotification).toHaveBeenCalledTimes(1)
    expect(showNotification.mock.calls[0][0]).toBe('Test notification')
  })

  it('leaves any other notification to the focused window', async () => {
    const { handlers, showNotification } = load([{ focused: true }])
    await push(handlers, dm)
    expect(showNotification).not.toHaveBeenCalled()
  })

  it('shows both once no window is focused', async () => {
    const { handlers, showNotification } = load([{ focused: false }])
    await push(handlers, testPush)
    await push(handlers, dm)
    expect(showNotification.mock.calls.map(([title]) => title)).toEqual(['Test notification', 'Alice sent you a message'])
  })
})
