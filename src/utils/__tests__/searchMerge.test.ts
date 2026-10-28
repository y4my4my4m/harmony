import { describe, expect, it } from 'vitest'
import { localWindow, mergeSearchPage, type MergeInput } from '@/utils/searchMerge'
import type { Message } from '@/types'

const at = (day: number) => new Date(Date.UTC(2025, 0, day))
const m = (id: string, day: number): Message => ({ id, created_at: at(day), content: [] })
const ids = (list: Message[]) => list.map(x => x.id)

type Input = Partial<MergeInput> & Pick<MergeInput, 'server' | 'page'>
const merge = (input: Input) => mergeSearchPage({
  pageSize: 2, serverPageCount: 0, sort: 'newest', fuzzy: false, before: null, local: [], windowed: input.local ?? [], ...input,
})

describe('mergeSearchPage', () => {
  it('pages local results alone without server results', () => {
    const local = Array.from({ length: 30 }, (_, i) => m(`l${i}`, 30 - i))
    const first = merge({ server: [], page: 0, pageSize: 25, local })
    expect(first.pageCount).toBe(2)
    expect(first.messages).toHaveLength(25)
    const second = merge({ server: [], page: 1, pageSize: 25, local })
    expect(ids(second.messages)).toEqual(['l25', 'l26', 'l27', 'l28', 'l29'])
  })

  it('puts each local result on the server page its time falls in, newest first', () => {
    // Server pages of two: [20, 18] [16, 14] [12]; local at 21, 17, 15, 13, 2.
    const local = [m('l21', 21), m('l17', 17), m('l15', 15), m('l13', 13), m('l2', 2)]
    const page = (p: number, server: Message[], before: Date | null) =>
      ids(merge({ server, page: p, serverPageCount: 3, local, before }).messages)
    expect(page(0, [m('s20', 20), m('s18', 18)], null)).toEqual(['l21', 's20', 's18'])
    expect(page(1, [m('s16', 16), m('s14', 14)], at(18))).toEqual(['l17', 's16', 'l15', 's14'])
    expect(page(2, [m('s12', 12)], at(14))).toEqual(['l13', 's12', 'l2'])
  })

  it('shows no local result twice across pages (negative control for the window)', () => {
    const local = [m('l17', 17), m('l15', 15)]
    const p0 = merge({ server: [m('s20', 20), m('s18', 18)], page: 0, serverPageCount: 2, local })
    const p1 = merge({ server: [m('s16', 16)], page: 1, serverPageCount: 2, local, before: at(18) })
    expect(ids(p0.messages)).not.toContain('l17')
    expect(ids(p1.messages).filter(id => id.startsWith('l'))).toEqual(['l17', 'l15'])
  })

  it('mirrors the windows oldest first', () => {
    const local = [m('l1', 1), m('l4', 4), m('l9', 9)]
    const p0 = merge({ server: [m('s2', 2), m('s3', 3)], page: 0, serverPageCount: 2, sort: 'oldest', local })
    const p1 = merge({ server: [m('s5', 5)], page: 1, serverPageCount: 2, sort: 'oldest', local, before: at(3) })
    expect(ids(p0.messages)).toEqual(['l1', 's2', 's3'])
    expect(ids(p1.messages)).toEqual(['l4', 's5', 'l9'])
  })

  it('shows the window the device read for a page past its first local results', () => {
    // The first local results end at day 20; page 1's window holds day 5, read on its own.
    const local = [m('l25', 25), m('l20', 20)]
    const p1 = merge({ server: [m('s8', 8), m('s6', 6)], page: 1, serverPageCount: 3, local, windowed: [m('l7', 7)], before: at(10) })
    expect(ids(p1.messages)).toEqual(['s8', 'l7', 's6'])
  })

  it('a page past the end of the server matches shows no local result', () => {
    const local = [m('l17', 17), m('l3', 3)]
    const past = merge({ server: [], page: 4, serverPageCount: 3, local, before: null })
    expect(past.messages).toEqual([])
    expect(localWindow({ server: [], page: 4, pageSize: 2, serverPageCount: 3, sort: 'newest', fuzzy: false, before: null }, 2)).toBeNull()
  })

  it('pages local results by count beside relevance pages', () => {
    const local = [m('l1', 9), m('l2', 8), m('l3', 7), m('l4', 6), m('l5', 5)]
    const p0 = merge({ server: [m('s5', 5)], page: 0, serverPageCount: 2, sort: 'relevance', local })
    const p1 = merge({ server: [m('s6', 6)], page: 1, serverPageCount: 2, sort: 'relevance', local })
    const p2 = merge({ server: [], page: 2, serverPageCount: 2, sort: 'relevance', local })
    expect(ids(p0.messages)).toEqual(['s5', 'l1', 'l2'])
    expect(ids(p1.messages)).toEqual(['s6', 'l3', 'l4'])
    expect(ids(p2.messages)).toEqual(['l5'])
    expect(p0.pageCount).toBe(3)
  })

  it('drops a local result the server page holds', () => {
    const shared = m('x', 5)
    expect(ids(merge({ server: [shared], page: 0, serverPageCount: 1, local: [shared] }).messages)).toEqual(['x'])
  })

  it('similar server rows give way to exact local results', () => {
    const similar = [m('s9', 9), m('s8', 8)]
    const alone = merge({ server: similar, page: 0, serverPageCount: 4, fuzzy: true })
    expect(ids(alone.messages)).toEqual(['s9', 's8'])
    expect(alone.similar).toBe(true)
    expect(alone.serverPageCount).toBe(4)

    const exact = merge({ server: similar, page: 0, serverPageCount: 4, fuzzy: true, local: [m('l3', 3)] })
    expect(ids(exact.messages)).toEqual(['l3'])
    expect(exact.similar).toBe(false)
    expect(exact.serverPageCount).toBe(0)
    expect(exact.pageCount).toBe(1)
  })
})

describe('localWindow', () => {
  const input = { pageSize: 2, serverPageCount: 3, fuzzy: false } as const
  it('bounds a middle page by the match before it and its own last match, ms inclusive', () => {
    const w = localWindow({ ...input, server: [m('s16', 16), m('s14', 14)], page: 1, sort: 'newest', before: at(18) }, 5)
    expect(w).toEqual({ from: at(14).getTime(), to: at(18).getTime() - 1 })
    const o = localWindow({ ...input, server: [m('s5', 5), m('s7', 7)], page: 1, sort: 'oldest', before: at(3) }, 5)
    expect(o).toEqual({ from: at(3).getTime() + 1, to: at(7).getTime() })
  })

  it('opens the first page above and the last page below', () => {
    expect(localWindow({ ...input, server: [m('s20', 20), m('s18', 18)], page: 0, sort: 'newest', before: null }, 5))
      .toEqual({ from: at(18).getTime() })
    expect(localWindow({ ...input, server: [m('s12', 12)], page: 2, sort: 'newest', before: at(14) }, 5))
      .toEqual({ to: at(14).getTime() - 1 })
  })

  it('has no window under relevance or for similar rows', () => {
    expect(localWindow({ ...input, server: [m('s1', 1)], page: 0, sort: 'relevance', before: null }, 5)).toBeUndefined()
    expect(localWindow({ ...input, server: [m('s1', 1)], page: 0, sort: 'newest', fuzzy: true, before: null }, 0)).toBeUndefined()
  })
})
