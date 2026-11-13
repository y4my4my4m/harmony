import { describe, it, expect } from 'vitest'
import { readAllRows } from '@/services/pagedRead'

// A PostgREST table of `total` rows that answers at most `cap` rows per request, as
// db-max-rows does: status 200, no error, the exact count beside a cut page.
function table(total: number, cap: number, opts: { count?: boolean; failAt?: number } = {}) {
  const calls: Array<[number, number]> = []
  const build = () => ({
    range: async (from: number, to: number) => {
      calls.push([from, to])
      if (opts.failAt === calls.length) return { data: null, error: { message: 'boom' }, count: null }
      const end = Math.min(to + 1, from + cap, total)
      const data = Array.from({ length: Math.max(0, end - from) }, (_, i) => ({ n: from + i }))
      return { data, error: null, count: opts.count === false ? null : total }
    },
  })
  return { build, calls }
}

describe('readAllRows', () => {
  it('reads past a row cap equal to the page size', async () => {
    const { build, calls } = table(1503, 1000)
    const rows = await readAllRows(build)
    expect(rows).toHaveLength(1503)
    expect(rows.map(r => r.n)).toEqual(Array.from({ length: 1503 }, (_, i) => i))
    expect(calls).toEqual([[0, 999], [1000, 1999]])
  })

  it('reads past a row cap below the page size: a short page is not the end', async () => {
    const { build, calls } = table(1503, 400)
    const rows = await readAllRows(build)
    expect(rows).toHaveLength(1503)
    expect(calls.map(c => c[0])).toEqual([0, 400, 800, 1200])
  })

  it('makes one request for a table inside one page', async () => {
    const { build, calls } = table(3, 1000)
    expect(await readAllRows(build)).toHaveLength(3)
    expect(calls).toHaveLength(1)
  })

  it('makes one request for an empty table', async () => {
    const { build, calls } = table(0, 1000)
    expect(await readAllRows(build)).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('reads a table that is an exact multiple of the page without a trailing request', async () => {
    const { build, calls } = table(2000, 1000)
    expect(await readAllRows(build)).toHaveLength(2000)
    expect(calls).toHaveLength(2)
  })

  it('without a count, ends at the first short page', async () => {
    const { build, calls } = table(1503, 1000, { count: false })
    expect(await readAllRows(build)).toHaveLength(1503)
    expect(calls).toHaveLength(2)
  })

  it('stops when rows vanish under the count instead of asking forever', async () => {
    let asked = 0
    const build = () => ({
      range: async () => {
        asked++
        return { data: asked === 1 ? [{ n: 0 }] : [], error: null, count: 10 }
      },
    })
    expect(await readAllRows(build, 1)).toHaveLength(1)
    expect(asked).toBe(2)
  })

  it('throws the error of a failed page', async () => {
    const { build } = table(1503, 1000, { failAt: 2 })
    await expect(readAllRows(build)).rejects.toEqual({ message: 'boom' })
  })
})
