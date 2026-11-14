import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => ({ calls: [] as Array<{ name: string; args: any }>, answer: (_name: string, _args: any): any => ({ data: null, error: null }) }))

vi.mock('@/supabase', () => ({
  supabase: { rpc: vi.fn(async (name: string, args: any) => { rpc.calls.push({ name, args }); return rpc.answer(name, args) }) },
}))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import {
  fetchMemberPage,
  fetchMemberRoles,
  fetchRoleMemberCounts,
  fetchRoomMemberIds,
  memberDirectoryAvailable,
  resetMemberDirectoryAvailability,
  searchServerMembers,
} from '@/services/memberDirectoryService'

const MISSING = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.get_server_member_list' } }

beforeEach(() => {
  resetMemberDirectoryAvailability()
  rpc.calls.length = 0
  rpc.answer = () => ({ data: null, error: null })
})

describe('member directory calls', () => {
  it('asks for a page and normalises the answer', async () => {
    rpc.answer = () => ({
      data: { total: '1503', offset: 100, live: false, max_age_ms: 5000, groups: [{ key: 'online', count: '49' }], members: [{ id: 'm1' }] },
      error: null,
    })
    const page = await fetchMemberPage('s1', 100, 100, '  bo ')
    expect(rpc.calls).toEqual([{ name: 'get_server_member_list', args: { p_server_id: 's1', p_offset: 100, p_limit: 100, p_query: 'bo' } }])
    expect(page).toEqual({
      total: 1503, offset: 100, groups: [{ key: 'online', count: 49 }], members: [{ id: 'm1' }], live: false, maxAgeMs: 5000,
    })
  })

  it('an answer that says nothing of broadcasts or age is live and exact', async () => {
    rpc.answer = () => ({ data: { total: 2, offset: 0, groups: [], members: [] }, error: null })
    expect(await fetchMemberPage('s1', 0, 100)).toMatchObject({ live: true, maxAgeMs: 0 })
  })

  it('never asks for more than the function answers', async () => {
    await fetchMemberPage('s1', 0, 5000)
    expect(rpc.calls[0].args.p_limit).toBe(200)
  })

  it('an instance without the functions reads unavailable from then on, with no further call', async () => {
    rpc.answer = () => MISSING
    expect(await fetchMemberPage('s1', 0, 100)).toBeNull()
    expect(memberDirectoryAvailable()).toBe(false)
    expect(await searchServerMembers('s1', 'bob')).toBeNull()
    expect(await fetchMemberRoles('s1', ['u1'])).toBeNull()
    expect(await fetchRoleMemberCounts('s1')).toBeNull()
    expect(rpc.calls).toHaveLength(1)
  })

  it('another error is thrown and the directory stays available', async () => {
    rpc.answer = () => ({ data: null, error: { code: '42501', message: 'server members: not a member' } })
    await expect(fetchMemberPage('s1', 0, 100)).rejects.toMatchObject({ code: '42501' })
    expect(memberDirectoryAvailable()).toBe(true)
  })

  it('a blank search asks nothing', async () => {
    expect(await searchServerMembers('s1', '   ')).toEqual([])
    expect(rpc.calls).toEqual([])
  })

  it('member roles go out 200 ids at a time and merge', async () => {
    rpc.answer = (_name, args) => ({ data: Object.fromEntries(args.p_user_ids.slice(0, 1).map((id: string) => [id, ['r1']])), error: null })
    const ids = Array.from({ length: 450 }, (_, i) => `u${i}`)
    const roles = await fetchMemberRoles('s1', ids)
    expect(rpc.calls.map(c => c.args.p_user_ids.length)).toEqual([200, 200, 50])
    expect(roles).toEqual({ u0: ['r1'], u200: ['r1'], u400: ['r1'] })
  })

  it('room members come back as one array', async () => {
    rpc.answer = () => ({ data: ['u1', 'u2'], error: null })
    expect(await fetchRoomMemberIds('room-1')).toEqual(['u1', 'u2'])
    expect(rpc.calls).toEqual([{ name: 'get_room_member_id_list', args: { p_room_id: 'room-1' } }])
    rpc.answer = () => MISSING
    expect(await fetchRoomMemberIds('room-1')).toBeNull()
  })

  it('role counts come back as numbers', async () => {
    rpc.answer = () => ({ data: { r1: '12', r2: 3 }, error: null })
    expect(await fetchRoleMemberCounts('s1')).toEqual({ r1: 12, r2: 3 })
  })
})
