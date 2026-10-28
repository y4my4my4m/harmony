import { describe, expect, it } from 'vitest'
import { mergeSearchPage } from '@/utils/searchMerge'
import type { Message } from '@/types'

const at = (day: number) => new Date(Date.UTC(2025, 0, day))
const m = (id: string, day: number): Message => ({ id, created_at: at(day), content: [] })
const ids = (list: Message[]) => list.map(x => x.id)

describe('mergeSearchPage', () => {
  it('pages local results alone without server results', () => {
    const local = Array.from({ length: 30 }, (_, i) => m(`l${i}`, 30 - i))
    const first = mergeSearchPage({ server: [], page: 0, pageSize: 25, serverPageCount: 0, sort: 'newest', local, before: null })
    expect(first.pageCount).toBe(2)
    expect(first.messages).toHaveLength(25)
    const second = mergeSearchPage({ server: [], page: 1, pageSize: 25, serverPageCount: 0, sort: 'newest', local, before: null })
    expect(ids(second.messages)).toEqual(['l25', 'l26', 'l27', 'l28', 'l29'])
  })

  it('puts each local result on the server page its time falls in, newest first', () => {
    // Server pages of two: [20, 18] [16, 14] [12]; local at 21, 17, 15, 13, 2.
    const local = [m('l21', 21), m('l17', 17), m('l15', 15), m('l13', 13), m('l2', 2)]
    const page = (p: number, server: Message[], before: Date | null) =>
      ids(mergeSearchPage({ server, page: p, pageSize: 2, serverPageCount: 3, sort: 'newest', local, before }).messages)
    expect(page(0, [m('s20', 20), m('s18', 18)], null)).toEqual(['l21', 's20', 's18'])
    expect(page(1, [m('s16', 16), m('s14', 14)], at(18))).toEqual(['l17', 's16', 'l15', 's14'])
    expect(page(2, [m('s12', 12)], at(14))).toEqual(['l13', 's12', 'l2'])
  })

  it('shows no local result twice across pages (negative control for the window)', () => {
    const local = [m('l17', 17), m('l15', 15)]
    const p0 = mergeSearchPage({ server: [m('s20', 20), m('s18', 18)], page: 0, pageSize: 2, serverPageCount: 2, sort: 'newest', local, before: null })
    const p1 = mergeSearchPage({ server: [m('s16', 16)], page: 1, pageSize: 2, serverPageCount: 2, sort: 'newest', local, before: at(18) })
    expect(ids(p0.messages)).not.toContain('l17')
    expect(ids(p1.messages).filter(id => id.startsWith('l'))).toEqual(['l17', 'l15'])
  })

  it('mirrors the windows oldest first', () => {
    const local = [m('l1', 1), m('l4', 4), m('l9', 9)]
    const p0 = mergeSearchPage({ server: [m('s2', 2), m('s3', 3)], page: 0, pageSize: 2, serverPageCount: 2, sort: 'oldest', local, before: null })
    const p1 = mergeSearchPage({ server: [m('s5', 5)], page: 1, pageSize: 2, serverPageCount: 2, sort: 'oldest', local, before: at(3) })
    expect(ids(p0.messages)).toEqual(['l1', 's2', 's3'])
    expect(ids(p1.messages)).toEqual(['l4', 's5', 'l9'])
  })

  it('appends local results to the first relevance page', () => {
    const local = [m('l1', 1)]
    expect(ids(mergeSearchPage({ server: [m('s5', 5)], page: 0, pageSize: 2, serverPageCount: 2, sort: 'relevance', local, before: null }).messages)).toEqual(['s5', 'l1'])
    expect(ids(mergeSearchPage({ server: [m('s6', 6)], page: 1, pageSize: 2, serverPageCount: 2, sort: 'relevance', local, before: null }).messages)).toEqual(['s6'])
  })

  it('drops a local result the server page holds', () => {
    const shared = m('x', 5)
    expect(ids(mergeSearchPage({ server: [shared], page: 0, pageSize: 2, serverPageCount: 1, sort: 'newest', local: [shared], before: null }).messages)).toEqual(['x'])
  })
})
