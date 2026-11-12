/**
 * fetchUserProfile(id, true) reads the database even for a user cached a moment ago, and the
 * composable the settings page and member list read (useUserData) shows the new values.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ME = 'aaaaaaaa-0000-4000-8000-0000000000a1'

const db = vi.hoisted(() => ({ name: 'Stale Name', avatar: 'old.png', reads: 0 }))

vi.mock('@/supabase', () => {
  const profiles = () => {
    const q: any = {
      select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
      then: (resolve: any) => {
        db.reads++
        return resolve({
          data: [{ id: ME, username: 'me', display_name: db.name, avatar_url: db.avatar, is_local: true }],
          error: null,
        })
      },
    }
    return q
  }
  return {
    SUPABASE_URL: 'http://db.test',
    SUPABASE_ANON_KEY: 'anon',
    supabase: {
      from: profiles,
      rpc: vi.fn(async () => ({ data: null, error: null })),
      channel: () => ({ on: () => ({}), subscribe: () => ({}) }),
      removeChannel: vi.fn(async () => 'ok'),
      auth: {
        getSession: async () => ({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
    },
  }
})

import { userDataService } from '../userDataService'
import { useUserData } from '@/composables/useUserData'

beforeEach(() => {
  ;(userDataService as any).users.clear()
  ;(userDataService as any).currentUserId = ME
  db.name = 'Stale Name'
  db.avatar = 'old.png'
  db.reads = 0
})

describe('fetchUserProfile with forceRefresh', () => {
  it('reloads a freshly cached user and the composable shows the new name and avatar', async () => {
    const { getCurrentUser } = useUserData()
    await userDataService.fetchUserProfile(ME)
    expect(getCurrentUser.value?.displayName).toBe('Stale Name')

    db.name = "ROODAY's Stand"
    db.avatar = 'new.png'
    await userDataService.fetchUserProfile(ME)
    expect(getCurrentUser.value?.displayName).toBe('Stale Name') // cached within the TTL, as before

    await userDataService.fetchUserProfile(ME, true)
    expect(getCurrentUser.value?.displayName).toBe("ROODAY's Stand")
    expect(getCurrentUser.value?.avatarUrl).toBe('new.png')
  })

  it('keeps the cache for a plain fetch', async () => {
    await userDataService.fetchUserProfile(ME)
    await userDataService.fetchUserProfile(ME)
    expect(db.reads).toBe(1)
  })
})
