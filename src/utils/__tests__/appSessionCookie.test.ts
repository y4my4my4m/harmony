/**
 * The app's session cookie (harmony_app=1), which the reverse proxy reads on /@ paths, and the
 * hop guard the app shares with the public page's script.
 */

import { describe, it, expect } from 'vitest'
import {
  APP_SESSION_COOKIE,
  PUBLIC_PAGE_HOP_KEY,
  PUBLIC_PAGE_HOP_WINDOW_MS,
  claimPublicPageHop,
  hasAppSessionCookie,
  setAppSessionCookie,
} from '../appSessionCookie'

/** A cookie jar that records each write, as document.cookie keeps one value per name. */
function jar(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const writes: string[] = []
  return {
    writes,
    get cookie() {
      return [...values].map(([k, v]) => `${k}=${v}`).join('; ')
    },
    set cookie(line: string) {
      writes.push(line)
      const [pair, ...attrs] = line.split('; ')
      const [name, value] = pair.split('=')
      if (attrs.includes('Max-Age=0')) values.delete(name)
      else values.set(name, value)
    },
  }
}

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
  }
}

describe('setAppSessionCookie', () => {
  it('names the cookie the backend page and the proxy read', () => {
    expect(APP_SESSION_COOKIE).toBe('harmony_app')
    expect(PUBLIC_PAGE_HOP_KEY).toBe('harmony:publicPageHop')
  })

  it('sets harmony_app=1 for the whole site, Lax, Secure on https', () => {
    const doc = jar({ theme: 'dark' })
    setAppSessionCookie(true, doc, { protocol: 'https:' })
    expect(doc.writes).toEqual(['harmony_app=1; Path=/; Max-Age=34560000; SameSite=Lax; Secure'])
    expect(hasAppSessionCookie(doc)).toBe(true)
  })

  it('leaves Secure off on plain http', () => {
    const doc = jar()
    setAppSessionCookie(true, doc, { protocol: 'http:' })
    expect(doc.writes).toEqual(['harmony_app=1; Path=/; Max-Age=34560000; SameSite=Lax'])
  })

  it('clears the cookie on sign-out', () => {
    const doc = jar({ harmony_app: '1', theme: 'dark' })
    setAppSessionCookie(false, doc, { protocol: 'https:' })
    expect(doc.writes).toEqual(['harmony_app=; Path=/; Max-Age=0; SameSite=Lax; Secure'])
    expect(hasAppSessionCookie(doc)).toBe(false)
    expect(doc.cookie).toBe('theme=dark')
  })

  it('writes nothing when the cookie already says so', () => {
    const on = jar({ harmony_app: '1' })
    setAppSessionCookie(true, on, { protocol: 'https:' })
    const off = jar()
    setAppSessionCookie(false, off, { protocol: 'https:' })
    expect([...on.writes, ...off.writes]).toEqual([])
  })

  it('does not take another cookie whose name ends the same for it', () => {
    expect(hasAppSessionCookie({ cookie: 'not_harmony_app=1' })).toBe(false)
    expect(hasAppSessionCookie({ cookie: 'harmony_app=10' })).toBe(false)
    expect(hasAppSessionCookie({ cookie: 'a=b; harmony_app=1' })).toBe(true)
  })
})

describe('claimPublicPageHop', () => {
  it('allows a hop and records it with its time', () => {
    const storage = memoryStorage()
    expect(claimPublicPageHop('/@alice', storage, 5000)).toBe(true)
    expect(storage.map.get(PUBLIC_PAGE_HOP_KEY)).toBe('/@alice 5000')
  })

  it('refuses the same hop within the window, then allows it again', () => {
    const storage = memoryStorage()
    expect(claimPublicPageHop('/@alice', storage, 5000)).toBe(true)
    expect(claimPublicPageHop('/@alice', storage, 5000 + PUBLIC_PAGE_HOP_WINDOW_MS - 1)).toBe(false)
    expect(storage.map.has(PUBLIC_PAGE_HOP_KEY)).toBe(false)
    expect(claimPublicPageHop('/@alice', storage, 5000 + PUBLIC_PAGE_HOP_WINDOW_MS)).toBe(true)
  })

  it('allows a hop to another target', () => {
    const storage = memoryStorage()
    claimPublicPageHop('/@alice', storage, 5000)
    expect(claimPublicPageHop('/@bob', storage, 5001)).toBe(true)
  })

  it('reads the record the public page writes', () => {
    const storage = memoryStorage()
    storage.setItem(PUBLIC_PAGE_HOP_KEY, '/@alice 9000')
    expect(claimPublicPageHop('/@alice', storage, 9500)).toBe(false)
  })

  it('refuses without storage', () => {
    expect(claimPublicPageHop('/@alice', null)).toBe(false)
    const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => {}, removeItem: () => {} }
    expect(claimPublicPageHop('/@alice', throwing)).toBe(false)
  })
})
