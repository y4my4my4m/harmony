import { describe, it, expect, beforeEach, vi } from 'vitest'
import { supabase } from '@/supabase'

const PROFILE_ID = '11111111-1111-1111-1111-111111111111'
const OTHER_ID = '22222222-2222-2222-2222-222222222222'
const POST_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentProfileId: vi.fn().mockResolvedValue('11111111-1111-1111-1111-111111111111'),
    getCurrentAuthUser: vi.fn().mockResolvedValue({ id: 'auth-user' }),
  },
}))

import { CorePostService } from '@/services/core/CorePostService'

interface InteractionRow {
  id: string
  post_id: string
  user_id: string
  interaction_type: string
  emoji_id?: string | null
}

/**
 * post_interactions plus the behaviours toggleLike depends on:
 * update_post_reaction_counts (a favorite row moves posts.favorites_count by
 * one), the federated base count posts carries independently of local rows,
 * and sync_reaction_favourite: a reaction adds an implied favourite, and
 * deleting a favourite deletes its holder's reactions on the post.
 */
class FakeDb {
  rows: InteractionRow[] = []
  base = 0
  /** A favourite written by someone else between toggleLike's probe and its insert. */
  raceOnInsert = false
  private seq = 0

  add(row: Omit<InteractionRow, 'id'>): InteractionRow {
    const stored = { id: `row-${++this.seq}`, emoji_id: null, ...row }
    this.rows.push(stored)
    if (row.interaction_type === 'emoji_reaction' && !this.isFavorited(row.post_id, row.user_id)) {
      this.rows.push({ id: `row-${++this.seq}`, post_id: row.post_id, user_id: row.user_id, interaction_type: 'favorite', emoji_id: null })
    }
    return stored
  }

  remove(predicate: (row: InteractionRow) => boolean): void {
    const gone = this.rows.filter(predicate)
    this.rows = this.rows.filter((r) => !gone.includes(r))
    for (const fav of gone.filter((r) => r.interaction_type === 'favorite')) {
      this.rows = this.rows.filter((r) =>
        !(r.post_id === fav.post_id && r.user_id === fav.user_id && r.interaction_type === 'emoji_reaction'))
    }
  }

  favoritesCount(postId: string): number {
    return (
      this.base +
      this.rows.filter(
        (r) =>
          r.post_id === postId &&
          r.interaction_type === 'favorite',
      ).length
    )
  }

  // The predicate every read path applies: RPC is_favorited and
  // CorePostService.loadPost read the favorite row alone.
  isFavorited(postId: string, userId: string): boolean {
    return this.rows.some(
      (r) => r.post_id === postId && r.user_id === userId && r.interaction_type === 'favorite',
    )
  }
}

function installClient(db: FakeDb) {
  const matches = (
    row: any,
    filters: Record<string, unknown>,
    inFilter: { col: string; vals: unknown[] } | null,
  ) => {
    for (const [col, val] of Object.entries(filters)) {
      if (row[col] !== val) return false
    }
    if (inFilter && !inFilter.vals.includes(row[inFilter.col])) return false
    return true
  }

  function query(table: string, op: 'select' | 'delete') {
    const filters: Record<string, unknown> = {}
    let inFilter: { col: string; vals: unknown[] } | null = null
    let limitN: number | undefined

    const run = () => {
      if (table === 'posts') {
        const rows = [{ favorites_count: db.favoritesCount(filters.id as string) }]
        return { data: rows, error: null }
      }
      const hits = db.rows.filter((r) => matches(r, filters, inFilter))
      if (op === 'delete') {
        db.remove((r) => matches(r, filters, inFilter))
        return { data: null, error: null }
      }
      return { data: limitN === undefined ? hits : hits.slice(0, limitN), error: null }
    }

    const builder: any = {
      eq(col: string, val: unknown) {
        filters[col] = val
        return builder
      },
      match(obj: Record<string, unknown>) {
        Object.assign(filters, obj)
        return builder
      },
      in(col: string, vals: unknown[]) {
        inFilter = { col, vals }
        return builder
      },
      limit(n: number) {
        limitN = n
        return builder
      },
      // PostgREST: zero rows is null, more than one is an error.
      maybeSingle() {
        const { data, error } = run()
        if (error) return Promise.resolve({ data: null, error })
        const rows = (data as any[]) || []
        if (rows.length > 1) {
          return Promise.resolve({
            data: null,
            error: { code: 'PGRST116', message: 'multiple rows returned' },
          })
        }
        return Promise.resolve({ data: rows[0] ?? null, error: null })
      },
      single() {
        const { data, error } = run()
        const rows = (data as any[]) || []
        if (error || rows.length !== 1) {
          return Promise.resolve({
            data: null,
            error: error ?? { code: 'PGRST116', message: 'no rows returned' },
          })
        }
        return Promise.resolve({ data: rows[0], error: null })
      },
      then(resolve: any, reject: any) {
        return Promise.resolve(run()).then(resolve, reject)
      },
    }
    return builder
  }

  ;(supabase.from as any).mockImplementation((table: string) => ({
    select: () => query(table, 'select'),
    delete: () => query(table, 'delete'),
    insert: (row: any) => {
      if (db.raceOnInsert) {
        db.add({ ...row })
        return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value' } })
      }
      db.add(row)
      return Promise.resolve({ data: null, error: null })
    },
  }))
}

describe('CorePostService.toggleLike', () => {
  let service: CorePostService
  let db: FakeDb

  beforeEach(() => {
    vi.clearAllMocks()
    db = new FakeDb()
    installClient(db)
    service = CorePostService.getInstance()
  })

  it('reads a reaction\'s implied favourite as the filled heart: toggling unfavourites, reaction included', async () => {
    db.add({ post_id: POST_ID, user_id: PROFILE_ID, interaction_type: 'emoji_reaction', emoji_id: 'thumbsup' })

    expect(db.isFavorited(POST_ID, PROFILE_ID)).toBe(true)
    expect(db.favoritesCount(POST_ID)).toBe(1)

    const result = await service.toggleLike(POST_ID)

    expect(result.liked).toBe(false)
    expect(result.newCount).toBe(0)
    expect(db.rows).toHaveLength(0)
  })

  it('unfavourites with one delete of the favourite, which takes the reactions, leaving the federated base', async () => {
    db.base = 554
    db.add({ post_id: POST_ID, user_id: PROFILE_ID, interaction_type: 'favorite' })
    for (const emoji of ['thumbsup', 'eyes', 'skull']) {
      db.add({ post_id: POST_ID, user_id: PROFILE_ID, interaction_type: 'emoji_reaction', emoji_id: emoji })
    }
    expect(db.favoritesCount(POST_ID)).toBe(555)

    const result = await service.toggleLike(POST_ID)

    expect(result.liked).toBe(false)
    expect(result.newCount).toBe(554)
    expect(db.rows).toHaveLength(0)
  })

  it('counts a favourite written between the probe and the insert as liked', async () => {
    db.raceOnInsert = true

    const result = await service.toggleLike(POST_ID)

    expect(result.liked).toBe(true)
    expect(result.newCount).toBe(1)
  })

  it('favourites a post the user has not touched', async () => {
    db.base = 3

    const result = await service.toggleLike(POST_ID)

    expect(result.liked).toBe(true)
    expect(result.newCount).toBe(4)
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({
      post_id: POST_ID,
      user_id: PROFILE_ID,
      interaction_type: 'favorite',
      is_local: true,
    })
  })

  it('unfavourites a plain favourite', async () => {
    db.add({ post_id: POST_ID, user_id: PROFILE_ID, interaction_type: 'favorite' })

    const result = await service.toggleLike(POST_ID)

    expect(result.liked).toBe(false)
    expect(result.newCount).toBe(0)
    expect(db.rows).toHaveLength(0)
  })

  it('leaves other users rows and other interaction types alone', async () => {
    db.add({ post_id: POST_ID, user_id: OTHER_ID, interaction_type: 'favorite' })
    db.add({ post_id: POST_ID, user_id: PROFILE_ID, interaction_type: 'bookmark' })
    db.add({ post_id: POST_ID, user_id: PROFILE_ID, interaction_type: 'reblog' })
    db.add({ post_id: POST_ID, user_id: PROFILE_ID, interaction_type: 'favorite' })
    db.add({ post_id: POST_ID, user_id: PROFILE_ID, interaction_type: 'emoji_reaction', emoji_id: 'eyes' })

    const result = await service.toggleLike(POST_ID)

    expect(result.liked).toBe(false)
    expect(result.newCount).toBe(1)
    expect(db.rows.map((r) => `${r.user_id}:${r.interaction_type}`).sort()).toEqual([
      `${PROFILE_ID}:bookmark`,
      `${PROFILE_ID}:reblog`,
      `${OTHER_ID}:favorite`,
    ])
  })
})
