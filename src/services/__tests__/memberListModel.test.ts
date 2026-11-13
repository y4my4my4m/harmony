import { describe, it, expect } from 'vitest'
import { MAX_LOADED_PAGES, MEMBER_PAGE_ROWS, MemberListModel, pageOffsetOf } from '@/services/memberListModel'
import type { DirectoryMember, MemberListPage } from '@/services/memberDirectoryService'

const member = (n: number, group = 'offline'): DirectoryMember =>
  ({ id: `m${n}`, group, username: `user${n}`, online: group !== 'offline', presence_status: 0, is_mobile: false, role_ids: [] })

// A server of 20 online and `offline` offline members, in list order: m0..m19 online, the rest offline.
function page(offset: number, limit: number, offline = 480, online = 20): MemberListPage {
  const total = online + offline
  const members: DirectoryMember[] = []
  for (let i = offset; i < Math.min(offset + limit, total); i++) members.push(member(i, i < online ? 'online' : 'offline'))
  return { total, offset, groups: [{ key: 'online', count: online }, { key: 'offline', count: offline }], members }
}

describe('MemberListModel', () => {
  it('lays out headers, loaded members and placeholders in the instance order', () => {
    const model = new MemberListModel()
    model.apply(page(0, MEMBER_PAGE_ROWS))
    const slots = model.slots()
    expect(slots).toHaveLength(2 + 500)
    expect(slots[0]).toEqual({ type: 'header', groupKey: 'online', count: 20 })
    expect(slots[1]).toMatchObject({ type: 'member', groupKey: 'online', index: 0, member: { id: 'm0' } })
    expect(slots[21]).toEqual({ type: 'header', groupKey: 'offline', count: 480 })
    expect(slots[22]).toMatchObject({ type: 'member', groupKey: 'offline', index: 20, member: { id: 'm20' } })
    expect(slots[101]).toMatchObject({ type: 'member', index: 99 })
    expect(slots[102]).toEqual({ type: 'placeholder', groupKey: 'offline', index: 100 })
    expect(slots.filter(s => s.type === 'placeholder')).toHaveLength(400)
  })

  it('a collapsed group keeps its header and its place in the order', () => {
    const model = new MemberListModel()
    model.apply(page(0, MEMBER_PAGE_ROWS))
    const slots = model.slots({ online: true })
    expect(slots[0]).toEqual({ type: 'header', groupKey: 'online', count: 20 })
    expect(slots[1]).toEqual({ type: 'header', groupKey: 'offline', count: 480 })
    expect(slots[2]).toMatchObject({ type: 'member', index: 20, member: { id: 'm20' } })
  })

  it('names the pages a range needs and stops naming them once loaded', () => {
    const model = new MemberListModel()
    model.apply(page(0, MEMBER_PAGE_ROWS))
    expect(model.wanted([[0, 99]])).toEqual([])
    expect(model.wanted([[90, 210]])).toEqual([100, 200])
    expect(model.wanted([[-30, 40]])).toEqual([])
    expect(model.wanted([[450, 9999]])).toEqual([400])
    model.apply(page(200, MEMBER_PAGE_ROWS))
    expect(model.wanted([[90, 210]])).toEqual([100])
  })

  it('splits a response longer than a page into pages', () => {
    const model = new MemberListModel()
    model.apply(page(0, 200))
    expect(model.wanted([[0, 199]])).toEqual([])
    expect(model.loadedIds()).toHaveLength(200)
  })

  it('a response with other counts marks the pages held stale, and keeps them on screen', () => {
    const model = new MemberListModel()
    model.apply(page(0, MEMBER_PAGE_ROWS))
    model.apply(page(100, MEMBER_PAGE_ROWS))
    // One offline member came online: 21 online, 479 offline.
    model.apply(page(100, MEMBER_PAGE_ROWS, 479, 21))
    expect(model.groups).toEqual([{ key: 'online', count: 21 }, { key: 'offline', count: 479 }])
    expect(model.wanted([[0, 199]])).toEqual([0])
    expect(model.wanted([[0, 199]], false), 'a stale page is not absent').toEqual([])
    expect(model.stale([[0, 199]])).toEqual([0])
    expect(model.stale([[100, 199]])).toEqual([])
    expect(model.slots().filter(s => s.type === 'member').length).toBeGreaterThan(190)
  })

  it('a member in a stale page and a fresh page shows once, at the fresh position', () => {
    const model = new MemberListModel()
    model.apply(page(0, MEMBER_PAGE_ROWS))
    // The fresh second page starts one member earlier in the id sequence: it now holds m99.
    const moved = page(100, MEMBER_PAGE_ROWS, 481, 20)
    moved.members = [member(99), ...moved.members.slice(0, -1)]
    model.apply(moved)
    const shown = model.slots().filter(s => s.type === 'member' && s.member.id === 'm99')
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ index: 100 })
    expect(model.slots()[101]).toEqual({ type: 'placeholder', groupKey: 'offline', index: 99 })
  })

  it('markAllStale asks for every held page again', () => {
    const model = new MemberListModel()
    model.apply(page(0, 200))
    model.markAllStale()
    expect(model.wanted([[0, 199]])).toEqual([0, 100])
  })

  it('keeps the pages nearest the viewport', () => {
    const model = new MemberListModel()
    for (let offset = 0; offset < 1000; offset += MEMBER_PAGE_ROWS) model.apply(page(offset, MEMBER_PAGE_ROWS, 980))
    model.trim([[900, 950]])
    expect(model.loadedIds()).toHaveLength(MAX_LOADED_PAGES * MEMBER_PAGE_ROWS)
    expect(model.wanted([[900, 999]])).toEqual([])
    expect(model.wanted([[0, 99]])).toEqual([0])
  })

  it('drops pages past the end when the list shrinks', () => {
    const model = new MemberListModel()
    model.apply(page(400, MEMBER_PAGE_ROWS))
    model.apply(page(0, MEMBER_PAGE_ROWS, 80))
    expect(model.total).toBe(100)
    expect(model.loadedIds()).toHaveLength(100)
    expect(model.slots().filter(s => s.type === 'placeholder')).toHaveLength(0)
  })

  it('rows around a collapsed group are two runs: only their pages are wanted and kept', () => {
    // 30 role members on screen, then offline rows from index 3,030 on: 3,000 online collapsed between.
    const big = (offset: number): MemberListPage => ({
      total: 23030,
      offset,
      groups: [{ key: 'role:r', count: 30 }, { key: 'online', count: 3000 }, { key: 'offline', count: 20000 }],
      members: Array.from({ length: MEMBER_PAGE_ROWS }, (_, i) => member(offset + i)),
    })
    const model = new MemberListModel()
    model.apply(big(0))
    const runs: Array<[number, number]> = [[0, 29], [3030, 3050]]
    expect(model.wanted(runs)).toEqual([3000])
    model.apply(big(3000))
    expect(model.wanted(runs)).toEqual([])
    for (let offset = 5000; offset < 6000; offset += MEMBER_PAGE_ROWS) model.apply(big(offset))
    model.trim(runs)
    expect(model.wanted(runs), 'the pages on screen survive the trim').toEqual([])
  })

  it('asks for the first page until the instance has answered', () => {
    const model = new MemberListModel()
    expect(model.answered).toBe(false)
    expect(model.wanted([[0, 0]])).toEqual([0])
    expect(model.wanted([[500, 520]], false)).toEqual([0])
    model.apply({ total: 0, offset: 0, groups: [], members: [] })
    expect(model.answered).toBe(true)
    expect(model.wanted([[0, 0]])).toEqual([])
  })

  it('aligns page offsets', () => {
    expect(pageOffsetOf(0)).toBe(0)
    expect(pageOffsetOf(99)).toBe(0)
    expect(pageOffsetOf(100)).toBe(100)
    expect(pageOffsetOf(1234)).toBe(1200)
  })
})
