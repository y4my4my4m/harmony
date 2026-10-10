/**
 * CoreInteractionService follows against a follows table whose status the database sets
 * (guard_follow_client_write): accepted for a local account without approval, pending for a
 * locked or remote one, 42501 across a block.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { supabase } from '@/supabase'
import { createFakePostgrest } from '../../../../tests/helpers/fakePostgrest'

vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentProfileId: async () => 'me' },
}))

import { CoreInteractionService } from '../CoreInteractionService'

type Row = Record<string, any>
let tables: Record<string, Row[]>
let inserted: Row[]

function seed(follows: Row[] = []) {
  tables = {
    profiles: [
      { id: 'me', is_local: true, manually_approves_followers: false },
      { id: 'local-open', is_local: true, manually_approves_followers: false },
      { id: 'local-locked', is_local: true, manually_approves_followers: true },
      { id: 'remote', is_local: false, manually_approves_followers: false },
      { id: 'blocker', is_local: true, manually_approves_followers: false },
    ],
    follows,
  }
  inserted = []
  const db = createFakePostgrest(tables)
  ;(supabase.from as any).mockImplementation((table: string) => {
    const builder = db.from(table)
    if (table !== 'follows') return builder
    const insert = builder.insert
    builder.insert = (row: Row) => {
      inserted.push(row)
      if (row.following_id === 'blocker') {
        const failing: any = {
          select: () => failing,
          single: async () => ({ data: null, error: { code: '42501', message: 'a block stands between these accounts' } }),
        }
        return failing
      }
      const target = tables.profiles.find((p) => p.id === row.following_id)
      const status = target?.is_local && !target.manually_approves_followers ? 'accepted' : 'pending'
      return insert({ ...row, status })
    }
    return builder
  })
}

const service = new CoreInteractionService()
const followRow = (following: string) =>
  tables.follows.find((f) => f.follower_id === 'me' && f.following_id === following)

beforeEach(() => {
  vi.clearAllMocks()
  seed()
})

describe('CoreInteractionService.follow', () => {
  it('reports a follow of a remote account as a request, whatever the client would assume', async () => {
    await expect(service.follow('remote')).resolves.toEqual({ following: false, pending: true })
    expect(inserted).toEqual([{ follower_id: 'me', following_id: 'remote' }])
    expect(followRow('remote')?.status).toBe('pending')
  })

  it('reports a follow of a locked local account as a request', async () => {
    await expect(service.follow('local-locked')).resolves.toEqual({ following: false, pending: true })
  })

  it('reports a follow of a local account without approval as accepted', async () => {
    await expect(service.follow('local-open')).resolves.toEqual({ following: true, pending: false })
  })

  it('returns a standing request without deleting it', async () => {
    seed([{ id: 'f1', follower_id: 'me', following_id: 'local-locked', status: 'pending' }])

    await expect(service.follow('local-locked')).resolves.toEqual({ following: false, pending: true })
    expect(followRow('local-locked')).toMatchObject({ id: 'f1', status: 'pending' })
    expect(inserted).toEqual([])
  })

  it('replaces a rejected request with a new one', async () => {
    seed([{ id: 'f1', follower_id: 'me', following_id: 'local-locked', status: 'rejected' }])

    await expect(service.follow('local-locked')).resolves.toEqual({ following: false, pending: true })
    expect(tables.follows.filter((f) => f.following_id === 'local-locked')).toHaveLength(1)
    expect(followRow('local-locked')?.id).not.toBe('f1')
  })

  it('refuses a follow across a block', async () => {
    await expect(service.follow('blocker')).rejects.toMatchObject({ code: 'BLOCKED' })
  })
})

describe('CoreInteractionService.unfollow and toggleFollow', () => {
  it('withdraws a pending request', async () => {
    seed([{ id: 'f1', follower_id: 'me', following_id: 'remote', status: 'pending' }])

    await expect(service.unfollow('remote')).resolves.toEqual({ following: false, pending: false })
    expect(followRow('remote')).toBeUndefined()
  })

  it('toggles a standing request off and an absent one on', async () => {
    seed([{ id: 'f1', follower_id: 'me', following_id: 'remote', status: 'pending' }])

    await expect(service.toggleFollow('remote')).resolves.toEqual({ following: false, pending: false })
    expect(followRow('remote')).toBeUndefined()
    await expect(service.toggleFollow('remote')).resolves.toEqual({ following: false, pending: true })
  })
})

describe('CoreInteractionService.removeFollower', () => {
  it('deletes the follower\'s follow of the current account only', async () => {
    seed([
      { id: 'f1', follower_id: 'remote', following_id: 'me', status: 'accepted' },
      { id: 'f2', follower_id: 'remote', following_id: 'local-open', status: 'accepted' },
    ])

    await service.removeFollower('remote')
    expect(tables.follows.map((f) => f.id)).toEqual(['f2'])
  })

  it('fails when the user does not follow the current account', async () => {
    await expect(service.removeFollower('remote')).rejects.toMatchObject({ code: 'FOLLOWER_NOT_FOUND' })
  })
})
