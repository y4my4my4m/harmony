import { describe, it, expect, beforeEach, vi } from 'vitest'
import { supabase } from '@/supabase'
import { createFakePostgrest } from '../../../tests/helpers/fakePostgrest'

// profiles.id and auth.users.id differ: author_id and user_id reference profiles(id).
vi.mock('@/services/userDataService', () => ({
  userDataService: {
    getCurrentUser: () => ({ id: 'profile-me' }),
  },
}))

vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: async () => ({
      isAuthenticated: true,
      authUser: { id: 'auth-me' },
      profileId: 'profile-me',
    }),
    getCurrentProfileId: async () => 'profile-me',
  },
}))

import { activityPubService } from '@/services/activityPubService'

function seed(posts: any[] = [], interactions: any[] = []) {
  const db = createFakePostgrest({ posts, post_interactions: interactions })
  ;(supabase.from as any).mockImplementation(db.from)
  return db
}

describe('ActivityPubService keys profile-FK columns on the profile id', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('deletePost finds and soft-deletes a post authored by the current profile', async () => {
    const db = seed([{ id: 'post-1', author_id: 'profile-me', is_deleted: false, content: [] }])

    await activityPubService.deletePost('post-1')

    expect(db.tables.posts[0].is_deleted).toBe(true)
  })

  it('deletePost refuses a post authored by the auth uid of another profile', async () => {
    seed([{ id: 'post-1', author_id: 'auth-me', is_deleted: false, content: [] }])

    await expect(activityPubService.deletePost('post-1')).rejects.toThrow('not owned')
  })

  it('favoritePost writes user_id = profile id', async () => {
    const db = seed()

    await activityPubService.favoritePost('post-1')

    expect(db.tables.post_interactions).toHaveLength(1)
    expect(db.tables.post_interactions[0].user_id).toBe('profile-me')
  })

  it('unfavoritePost removes the profile row', async () => {
    const db = seed([], [
      { id: 'i-1', user_id: 'profile-me', post_id: 'post-1', interaction_type: 'favorite' },
    ])

    await activityPubService.unfavoritePost('post-1')

    expect(db.tables.post_interactions).toHaveLength(0)
  })
})
