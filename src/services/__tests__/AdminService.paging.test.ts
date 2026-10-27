/**
 * AdminService list paging: getUsers orders created_at ties by id so offset pages neither repeat
 * nor skip rows; pagePublicServersForAdmin ranges with an exact count and an id tiebreaker;
 * nextFeaturedOrder is one past the highest featured_order.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { supabase } from '@/supabase'
import { adminService } from '@/services/AdminService'

const from = supabase.from as unknown as ReturnType<typeof vi.fn>
const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

/** A PostgREST builder that records its calls and resolves to `result`. */
function builder(result: unknown) {
  const calls: Array<[string, unknown[]]> = []
  const query: Record<string, any> = {}
  for (const name of ['select', 'eq', 'neq', 'or', 'order', 'range', 'limit', 'in']) {
    query[name] = (...args: unknown[]) => {
      calls.push([name, args])
      return query
    }
  }
  query.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return { query, calls }
}

beforeEach(() => {
  from.mockReset()
  rpc.mockReset()
  rpc.mockResolvedValue({ data: [], error: null })
})

describe('AdminService paging', () => {
  it('getUsers breaks created_at ties by id and ranges the page', async () => {
    const { query, calls } = builder({ data: [], error: null, count: 0 })
    from.mockReturnValue(query)
    await adminService.getUsers(25, 50)
    expect(calls.filter(([n]) => n === 'order')).toEqual([
      ['order', ['created_at', { ascending: false }]],
      ['order', ['id', { ascending: false }]],
    ])
    expect(calls.find(([n]) => n === 'range')).toEqual(['range', [50, 74]])
  })

  it('pagePublicServersForAdmin returns one page with the exact total and member counts', async () => {
    const { query, calls } = builder({
      data: [{ id: 's1', name: 'One', is_featured: true, featured_order: 1 }],
      error: null,
      count: 120,
    })
    from.mockReturnValue(query)
    rpc.mockResolvedValue({ data: [{ server_id: 's1', member_count: '7' }], error: null })
    const page = await adminService.pagePublicServersForAdmin(50, 100)
    expect(calls.find(([n]) => n === 'select')).toEqual(['select', ['id, name, description, icon, is_featured, featured_order', { count: 'exact' }]])
    expect(calls.filter(([n]) => n === 'order').at(-1)).toEqual(['order', ['id', { ascending: true }]])
    expect(calls.find(([n]) => n === 'range')).toEqual(['range', [100, 149]])
    expect(page).toEqual({ servers: [{ id: 's1', name: 'One', is_featured: true, featured_order: 1, member_count: 7 }], total: 120 })
  })

  it('nextFeaturedOrder is one past the highest order, at least 1', async () => {
    from.mockReturnValueOnce(builder({ data: [{ featured_order: 4 }], error: null }).query)
    await expect(adminService.nextFeaturedOrder()).resolves.toBe(5)
    from.mockReturnValueOnce(builder({ data: [], error: null }).query)
    await expect(adminService.nextFeaturedOrder()).resolves.toBe(1)
  })
})
