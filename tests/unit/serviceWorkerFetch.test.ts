// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SOURCE = readFileSync(fileURLToPath(new URL('../../public/service-worker.js', import.meta.url)), 'utf8')
const ORIGIN = 'https://harmony.test'

function loadWorker() {
  const listeners = new Map<string, (event: any) => void>()
  const network = vi.fn(async () => new Response('{}', { status: 200 }))
  const cache = { match: vi.fn(), put: vi.fn(async () => {}), delete: vi.fn(), keys: vi.fn(async () => []) }
  const sandbox: any = {
    self: {
      addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, fn),
      location: { origin: ORIGIN },
      registration: { scope: `${ORIGIN}/` },
      clients: { matchAll: vi.fn(async () => []) },
    },
    caches: { open: vi.fn(async () => cache), match: vi.fn(async () => undefined), keys: vi.fn(async () => []) },
    fetch: network,
    navigator: {},
    console: { log() {}, warn() {}, error() {} },
    URL,
    Request,
    Response,
    AbortController,
    indexedDB: undefined,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(SOURCE, sandbox)

  const intercept = (request: Request) => {
    const respondWith = vi.fn()
    listeners.get('fetch')!({ request, respondWith })
    return respondWith
  }
  return { intercept, network }
}

describe('service worker fetch routing', () => {
  it('leaves a POST to the federation API to the browser', () => {
    const sw = loadWorker()
    const respondWith = sw.intercept(new Request(`${ORIGIN}/api/federation/fetch-replies`, {
      method: 'POST',
      body: JSON.stringify({ post_ap_id: 'https://remote.test/notes/1', async: true }),
      headers: { 'Content-Type': 'application/json' },
    }))
    expect(respondWith).not.toHaveBeenCalled()
    expect(sw.network).not.toHaveBeenCalled()
  })

  it('leaves every non-GET method alone, auth included', () => {
    const sw = loadWorker()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(sw.intercept(new Request(`${ORIGIN}/api/federation/x`, { method })).mock.calls).toHaveLength(0)
      expect(sw.intercept(new Request(`${ORIGIN}/auth/v1/token`, { method })).mock.calls).toHaveLength(0)
    }
  })

  it('leaves link-preview media to the browser: ranges and redirects', () => {
    const sw = loadWorker()
    const relayed = `${ORIGIN}/api/federation/embed-media?u=${encodeURIComponent('https://video.twimg.com/tweet_video/G.mp4')}`
    expect(sw.intercept(new Request(relayed, { headers: { Range: 'bytes=0-' } })).mock.calls).toHaveLength(0)
    expect(sw.intercept(new Request(`${ORIGIN}/api/federation/embed-media/instagram/DcCH2ZygIiP/0`)).mock.calls).toHaveLength(0)
    expect(sw.network).not.toHaveBeenCalled()
  })

  it('leaves a GET to the API to the browser: no cached answers, no 503 of its own', () => {
    const sw = loadWorker()
    expect(sw.intercept(new Request(`${ORIGIN}/api/federation/fetch-replies/status?post_ap_id=x`)).mock.calls).toHaveLength(0)
    expect(sw.network).not.toHaveBeenCalled()
  })
})
