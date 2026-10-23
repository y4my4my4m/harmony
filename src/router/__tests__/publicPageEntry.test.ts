/**
 * /@<name> and /@<name>/<post id> in the app (router PublicPage): the in-app profile or post for
 * a signed-in reader; signed out, one reload for the backend's public page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const auth = vi.hoisted(() => ({ isLoggedIn: true, session: null as unknown }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileFetched: true, profile: { username: 'me' } }) }))

const { default: router, publicPageEntry } = await import('../index')

const replace = vi.fn()

beforeEach(() => {
  auth.isLoggedIn = true
  replace.mockReset()
  sessionStorage.clear()
  vi.stubGlobal('location', { ...window.location, replace })
})

describe('PublicPage route', () => {
  it('matches /@<name> and /@<name>/<post id>', () => {
    expect(router.resolve('/@alice').name).toBe('PublicPage')
    expect(router.resolve('/@alice/0b0e0000-0000-4000-8000-000000000001').params).toMatchObject({
      username: 'alice',
      postId: '0b0e0000-0000-4000-8000-000000000001',
    })
    expect(router.resolve('/@bob@remote.example').params.username).toBe('bob@remote.example')
  })

  it('sends a signed-in reader to the in-app profile and post', () => {
    expect(publicPageEntry(router.resolve('/@alice?before=x'))).toEqual({ name: 'UserProfile', params: { handle: 'alice' }, replace: true })
    expect(publicPageEntry(router.resolve('/@bob@remote.example'))).toEqual({ name: 'UserProfile', params: { handle: 'bob@remote.example' }, replace: true })
    expect(publicPageEntry(router.resolve('/@alice/0b0e0000-0000-4000-8000-000000000001'))).toEqual({
      name: 'PostDetail', params: { postId: '0b0e0000-0000-4000-8000-000000000001' }, replace: true,
    })
    expect(router.resolve({ name: 'UserProfile', params: { handle: 'bob@remote.example' } }).path).toBe('/social/profile/bob@remote.example')
    expect(replace).not.toHaveBeenCalled()
  })

  it('reloads a signed-out visitor once for the public page, then goes in-app', () => {
    auth.isLoggedIn = false
    const to = router.resolve('/@alice')
    expect(publicPageEntry(to)).toBe(false)
    expect(replace).toHaveBeenCalledWith('/@alice')
    expect(publicPageEntry(to)).toEqual({ name: 'UserProfile', params: { handle: 'alice' }, replace: true })
    expect(replace).toHaveBeenCalledTimes(1)
  })
})
