// An instance's posts are its accounts' public posts, newest first. The domain filters the
// author embed (an inner join on posts_author_id_fkey): a lookup of the domain's profiles first,
// unordered and capped, missed every account past the cap.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { supabase } from '@/supabase'

vi.mock('@/services/userDataService', () => ({ userDataService: { getCurrentUser: () => ({ id: 'me' }) } }))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: async () => ({ isAuthenticated: true, authUser: { id: 'auth-me' }, profileId: 'me' }),
    getCurrentProfileId: async () => 'me',
  },
}))

import { activityPubService } from '@/services/activityPubService'

type Call = [string, ...unknown[]]

function recordQueries(rows: unknown[]) {
  const queries: { table: string; calls: Call[] }[] = []
  ;(supabase.from as any).mockImplementation((table: string) => {
    const calls: Call[] = []
    queries.push({ table, calls })
    const chain: any = new Proxy({}, {
      get(_target, prop: string) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: rows, error: null })
        return (...args: unknown[]) => { calls.push([prop, ...args]); return chain }
      },
    })
    return chain
  })
  return queries
}

const post = (id: string, at: string) => ({ id, created_at: at, author: { id: 'a', domain: 'peer.test' } })

describe('getInstanceActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads posts once, filtered on the author\'s domain through an inner join, newest first', async () => {
    const queries = recordQueries([post('p1', '2026-10-03'), post('p2', '2026-10-02')])
    const result = await activityPubService.getInstanceActivity('peer.test', { limit: 20 })

    expect(queries.map((q) => q.table)).toEqual(['posts'])
    const calls = queries[0].calls
    const select = calls.find(([op]) => op === 'select')![1] as string
    expect(select).toMatch(/author:profiles!posts_author_id_fkey!inner\(/)
    expect(calls).toContainEqual(['eq', 'author.domain', 'peer.test'])
    expect(calls).toContainEqual(['eq', 'visibility', 'public'])
    expect(calls).toContainEqual(['eq', 'is_deleted', false])
    expect(calls).toContainEqual(['order', 'created_at', { ascending: false }])
    expect(calls).toContainEqual(['limit', 21])
    expect(calls.some(([op]) => op === 'in')).toBe(false)
    expect(result).toEqual({ posts: [post('p1', '2026-10-03'), post('p2', '2026-10-02')], hasMore: false, cursor: null })
  })

  it('pages from a cursor', async () => {
    const rows = [post('p1', '2026-10-03'), post('p2', '2026-10-02'), post('p3', '2026-10-01')]
    const queries = recordQueries(rows)
    const result = await activityPubService.getInstanceActivity('peer.test', { limit: 2, cursor: '2026-10-04' })

    expect(queries[0].calls).toContainEqual(['lt', 'created_at', '2026-10-04'])
    expect(result.posts.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(result).toMatchObject({ hasMore: true, cursor: '2026-10-02' })
  })
})
