import { describe, it, expect, vi, beforeEach } from 'vitest'

// A PostgREST that answers at most 1000 rows per request, as hosted Supabase does.
const db = vi.hoisted(() => ({
  CAP: 1000,
  members: {} as Record<string, string[]>,
  requests: [] as Array<{ table: string; filters: Record<string, unknown>; range?: [number, number]; ids?: string[] }>,
}))

vi.mock('@/supabase', () => {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {}
    let ids: string[] | undefined
    const answer = (range?: [number, number]) => {
      db.requests.push({ table, filters: { ...filters }, range, ids })
      if (table === 'user_servers') {
        const all = (db.members[filters.server_id as string] ?? []).map(user_id => ({ user_id }))
        const start = range ? range[0] : 0
        const end = Math.min(range ? range[1] + 1 : all.length, start + db.CAP)
        return { data: all.slice(start, end), error: null, count: all.length }
      }
      return { data: (ids ?? []).map(id => ({ id, username: `u-${id}` })), error: null }
    }
    const q: any = {
      select: () => q,
      eq: (column: string, value: unknown) => { filters[column] = value; return q },
      or: (expression: string) => { filters.or = expression; return q },
      in: (_column: string, values: string[]) => { ids = values; return q },
      order: () => q,
      range: async (from: number, to: number) => answer([from, to]),
      then: (resolve: any) => resolve(answer()),
    }
    return q
  }
  return { supabase: { from } }
})

import { clearAllMemberCaches, getProfiles, getUserIdsForServer, invalidateServerMemberCache } from '@/services/usersService'

beforeEach(() => {
  clearAllMemberCaches()
  db.requests.length = 0
  db.members = {
    big: Array.from({ length: 1503 }, (_, i) => `m${i}`),
    small: ['a', 'b', 'c'],
  }
})

describe('getUserIdsForServer', () => {
  it('reads every member of a server larger than the row cap', async () => {
    const ids = await getUserIdsForServer('big')
    expect(ids).toHaveLength(1503)
    expect(new Set(ids).size).toBe(1503)
    expect(db.requests.map(r => r.range)).toEqual([[0, 999], [1000, 1999]])
  })

  it('reads accepted members, a row with no status among them', async () => {
    await getUserIdsForServer('small')
    expect(db.requests[0].filters).toEqual({ server_id: 'small', or: 'status.is.null,status.eq.accepted' })
  })

  it('answers a second call from the cache, and reads again once invalidated', async () => {
    await getUserIdsForServer('small')
    await getUserIdsForServer('small')
    expect(db.requests).toHaveLength(1)
    invalidateServerMemberCache('small')
    await getUserIdsForServer('small')
    expect(db.requests).toHaveLength(2)
  })

  it('shares one read between concurrent callers', async () => {
    const [a, b] = await Promise.all([getUserIdsForServer('big'), getUserIdsForServer('big')])
    expect(a).toBe(b)
    expect(db.requests).toHaveLength(2)
  })
})

describe('getProfiles', () => {
  it('asks for profiles in chunks one URL can carry', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `p${i}`)
    const profiles = await getProfiles(ids)
    expect(profiles).toHaveLength(250)
    expect(db.requests.map(r => r.ids?.length)).toEqual([100, 100, 50])
  })
})
