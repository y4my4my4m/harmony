// @vitest-environment node
// public/service-worker.js transformImage: storage render images kept in Cache Storage.
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const source = fs.readFileSync(path.resolve(__dirname, '../../../public/service-worker.js'), 'utf8')

class FakeCache {
  entries = new Map<string, Response>()
  async match(key: string) { return this.entries.get(key)?.clone() }
  async put(key: string, response: Response) { this.entries.set(key, response) }
  async keys() { return [...this.entries.keys()].map((url) => ({ url, toString: () => url })) }
  async delete(key: string | { url: string }) { return this.entries.delete(typeof key === 'string' ? key : key.url) }
}

interface Sandbox {
  transformImage: (request: Request, url: URL) => Promise<Response>
  fetches: Array<{ url: string; mode?: string }>
  cache: FakeCache
}

function load(respond: (url: string, mode?: string) => Response): Sandbox {
  const cache = new FakeCache()
  const fetches: Array<{ url: string; mode?: string }> = []
  const context = vm.createContext({
    self: { addEventListener() {}, location: { origin: 'https://app.test' }, registration: {} },
    caches: { open: async () => cache, match: async () => undefined, keys: async () => [] },
    fetch: async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      fetches.push({ url, mode: init?.mode })
      return respond(url, init?.mode)
    },
    Response, Request, URL, Headers, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
  })
  vm.runInContext(source, context)
  return { transformImage: context.transformImage, fetches, cache }
}

const image = () => new Response('img', { status: 200, headers: { 'content-type': 'image/webp' } })
const settle = () => new Promise((r) => setTimeout(r, 10))
const EMOJI = 'https://db.test/storage/v1/render/image/public/emojis/s1/e1.png?width=64&height=64'
const AVATAR = 'https://db.test/storage/v1/render/image/public/avatars/u1/a.webp?width=80&height=80'
const call = (sw: Sandbox, url: string) => sw.transformImage(new Request(url), new URL(url))

describe('service worker storage render cache', () => {
  let sw: Sandbox
  beforeEach(() => { sw = load(() => image()) })

  it('fetches in cors mode and keeps the image', async () => {
    const response = await call(sw, EMOJI)
    expect(await response.text()).toBe('img')
    expect(sw.fetches).toEqual([{ url: EMOJI, mode: 'cors' }])
    await settle()
    expect(sw.cache.entries.has(EMOJI)).toBe(true)
  })

  it('serves an emoji render from the cache without a network request', async () => {
    await call(sw, EMOJI)
    await settle()
    const again = await call(sw, EMOJI)
    expect(await again.text()).toBe('img')
    expect(sw.fetches).toHaveLength(1)
  })

  it('refetches another render at most once per worker lifetime', async () => {
    await call(sw, AVATAR)
    await settle()
    await call(sw, AVATAR)
    await call(sw, AVATAR)
    await settle()
    expect(sw.fetches).toHaveLength(1)
  })

  it('does not keep an opaque or non-image answer', async () => {
    sw = load(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    await call(sw, EMOJI)
    await settle()
    expect(sw.cache.entries.size).toBe(0)
  })
})
