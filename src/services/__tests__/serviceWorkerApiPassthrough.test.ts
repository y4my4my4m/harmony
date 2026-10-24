// @vitest-environment node
// public/service-worker.js: API and auth requests pass through to the browser. The worker
// cached signed-in answers by URL alone and answered a 503 of its own after 5 s.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const source = fs.readFileSync(path.resolve(__dirname, '../../../public/service-worker.js'), 'utf8')

function load(cacheNames: string[] = []) {
  const handlers: Record<string, (event: any) => void> = {}
  const deleted: string[] = []
  const context = vm.createContext({
    self: {
      addEventListener: (type: string, fn: (event: any) => void) => { handlers[type] = fn },
      location: { origin: 'https://app.test' },
      registration: {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => ({ match: async () => undefined, put: async () => {} }),
      match: async () => undefined,
      keys: async () => cacheNames,
      delete: async (name: string) => { deleted.push(name); return true },
    },
    fetch: async () => new Response('net'),
    Response, Request, URL, Headers, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
  })
  vm.runInContext(source, context)
  return { handlers, deleted }
}

function fetchEvent(url: string) {
  const event = { request: new Request(url), respondWith: vi.fn() }
  return event
}

describe('service worker and API requests', () => {
  it('leaves same-origin API and auth GETs to the browser', () => {
    const { handlers } = load()
    for (const url of [
      'https://app.test/api/federation/push/vapid-key',
      'https://app.test/api/federation/push/subscriptions',
      'https://app.test/api/federation/auth/session',
    ]) {
      const event = fetchEvent(url)
      handlers.fetch(event)
      expect(event.respondWith, url).not.toHaveBeenCalled()
    }
  })

  it('still answers stylesheets from its static cache', () => {
    const { handlers } = load()
    const event = fetchEvent('https://app.test/theme.css')
    handlers.fetch(event)
    expect(event.respondWith).toHaveBeenCalledTimes(1)
  })

  it('drops the API response cache on activation and keeps the others', async () => {
    const { handlers, deleted } = load(['harmony-api-v3', 'harmony-static-v3', 'harmony-v5-mobile', 'harmony-emoji-v2'])
    let done: Promise<unknown> = Promise.resolve()
    handlers.activate({ waitUntil: (p: Promise<unknown>) => { done = p } })
    await done
    expect(deleted).toEqual(['harmony-api-v3'])
  })
})
