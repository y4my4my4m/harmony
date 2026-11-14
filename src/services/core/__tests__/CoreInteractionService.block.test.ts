/**
 * CoreInteractionService.setBlocked against a user_blocks table unique on (blocker_id,
 * blocked_user_id): the asked state is reached whatever the row was, so a stale client never
 * removes a block by asking for one.
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
let blockInsertError: { code: string; message: string } | null

function seed(blocks: Row[] = []) {
  tables = {
    user_blocks: blocks,
    follows: [{ id: 'f1', follower_id: 'me', following_id: 'them', status: 'accepted' }],
  }
  blockInsertError = null
  const db = createFakePostgrest(tables)
  ;(supabase.from as any).mockImplementation((table: string) => {
    const builder = db.from(table)
    if (table !== 'user_blocks') return builder
    const insert = builder.insert
    builder.insert = (row: Row) => {
      const duplicate = tables.user_blocks.some(
        (b) => b.blocker_id === row.blocker_id && b.blocked_user_id === row.blocked_user_id)
      const error = blockInsertError ?? (duplicate ? { code: '23505', message: 'duplicate key value' } : null)
      if (error) return { then: (resolve: any) => Promise.resolve({ data: null, error }).then(resolve) }
      return insert(row)
    }
    return builder
  })
}

const service = new CoreInteractionService()
const blockRows = () => tables.user_blocks.filter((b) => b.blocker_id === 'me' && b.blocked_user_id === 'them')

beforeEach(() => {
  vi.clearAllMocks()
  seed()
})

describe('CoreInteractionService.setBlocked', () => {
  it('blocks an account it had not blocked', async () => {
    await expect(service.setBlocked('them', true)).resolves.toEqual({ blocked: true })
    expect(blockRows()).toHaveLength(1)
  })

  it('keeps a block that already stands when asked to block', async () => {
    seed([{ id: 'b1', blocker_id: 'me', blocked_user_id: 'them' }])

    await expect(service.setBlocked('them', true)).resolves.toEqual({ blocked: true })
    expect(blockRows()).toEqual([{ id: 'b1', blocker_id: 'me', blocked_user_id: 'them' }])
  })

  it('removes the block when asked to unblock', async () => {
    seed([{ id: 'b1', blocker_id: 'me', blocked_user_id: 'them' }])

    await expect(service.setBlocked('them', false)).resolves.toEqual({ blocked: false })
    expect(blockRows()).toEqual([])
  })

  it('creates no block when asked to unblock an account it had not blocked', async () => {
    await expect(service.setBlocked('them', false)).resolves.toEqual({ blocked: false })
    expect(blockRows()).toEqual([])
  })

  it('reports a refused block', async () => {
    blockInsertError = { code: '42501', message: 'new row violates row-level security policy' }

    await expect(service.setBlocked('them', true)).rejects.toMatchObject({ code: 'BLOCK_FAILED' })
    expect(blockRows()).toEqual([])
  })

  it('refuses a block of itself', async () => {
    await expect(service.setBlocked('me', true)).rejects.toMatchObject({ code: 'INVALID_ACTION' })
  })
})
