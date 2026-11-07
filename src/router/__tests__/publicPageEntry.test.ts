/**
 * /@<handle> and /@<handle>/<post id>: the in-app profile and post (utils/permalinks.ts). The
 * handle loses a leading @ and this instance's domain; signed out, one reload for the backend's
 * public page, then sign in. Earlier addresses redirect.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const auth = vi.hoisted(() => ({ isLoggedIn: true, session: null as unknown }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileFetched: true, profile: { username: 'me' } }) }))

const { default: router, publicPageEntry, canonicalProfileParam } = await import('../index')

const replace = vi.fn()
const POST = '0b0e0000-0000-4000-8000-000000000001'

beforeEach(() => {
  auth.isLoggedIn = true
  replace.mockReset()
  sessionStorage.clear()
  vi.stubGlobal('location', { ...window.location, replace })
})

describe('account routes', () => {
  it('name /@<handle> UserProfile and /@<handle>/<post id> PostPermalink', () => {
    expect(router.resolve('/@alice').name).toBe('UserProfile')
    expect(router.resolve('/@bob@remote.example').params.handle).toBe('bob@remote.example')
    expect(router.resolve(`/@alice/${POST}`)).toMatchObject({ name: 'PostPermalink', params: { handle: 'alice', postId: POST } })
    expect(router.resolve(`/@bob@remote.example/${POST}`).name).toBe('PostPermalink')
    expect(router.resolve('/@alice/media').name).toBe('CatchAll')
    expect(router.resolve({ name: 'UserProfile', params: { handle: 'bob@remote.example' } }).path).toBe('/@bob@remote.example')
    expect(router.resolve({ name: 'HashtagView', params: { tag: 'art' } }).path).toBe('/tags/art')
  })

  it('redirects the earlier addresses', () => {
    const cases: Array<[string, string]> = [
      ['/social/profile/alice', '/@alice'],
      ['/social/profile/bob@remote.example', '/@bob@remote.example'],
      ['/profile/alice', '/@alice'],
      ['/users/alice', '/@alice'],
      ['/social/hashtag/art', '/tags/art'],
    ]
    return Promise.all(cases.map(async ([from, to]) => {
      // Route records only: the redirects, without the app's guards.
      const r = createRouter({ history: createMemoryHistory(), routes: router.options.routes })
      await r.push(from)
      expect(r.currentRoute.value.path, from).toBe(to)
    }))
  })

  it('spells the handle without a leading @ or this instance\'s domain', () => {
    expect(canonicalProfileParam('@alice')).toBe('alice')
    expect(canonicalProfileParam('alice@harmony.test')).toBe('alice')
    expect(canonicalProfileParam('alice%40Harmony.Test')).toBe('alice')
    expect(canonicalProfileParam('@bob@remote.example')).toBe('bob@remote.example')
    expect(publicPageEntry(router.resolve('/@@bob@remote.example'))).toMatchObject({ name: 'UserProfile', params: { handle: 'bob@remote.example' } })
    expect(publicPageEntry(router.resolve(`/@alice@harmony.test/${POST}`))).toMatchObject({ name: 'PostPermalink', params: { handle: 'alice', postId: POST } })
  })

  it('lets a signed-in reader in', () => {
    expect(publicPageEntry(router.resolve('/@alice?before=x'))).toBe(true)
    expect(publicPageEntry(router.resolve(`/@alice/${POST}`))).toBe(true)
    expect(replace).not.toHaveBeenCalled()
  })

  it('reloads a signed-out visitor once for the public page, then sends them to sign in', () => {
    auth.isLoggedIn = false
    const to = router.resolve('/@alice')
    expect(publicPageEntry(to)).toBe(false)
    expect(replace).toHaveBeenCalledWith('/@alice')
    expect(publicPageEntry(to)).toEqual({ name: 'Login', query: { redirect: '/@alice' } })
    expect(replace).toHaveBeenCalledTimes(1)
  })
})
