// Reads every row of a PostgREST query in pages.
//
// PostgREST answers at most db-max-rows rows (1000 on hosted Supabase and the Supabase CLI)
// with status 200 and no error: a read without a range is cut there. A page here ends at
// the exact count of the first response, not at a short page, so a cap below the page size
// still reads to the end.

/** Rows asked per request. */
export const READ_PAGE_ROWS = 1000

/** Requests one read may make: 500,000 rows at the default page size. */
const MAX_PAGES = 500

interface PageResult<T> {
  data: T[] | null
  error: unknown
  count?: number | null
}

/** A query the caller built with `{ count: 'exact' }` and an order over a unique key. */
interface RangedQuery<T> {
  range(from: number, to: number): PromiseLike<PageResult<T>>
}

/**
 * Every row of the query `build` returns. `build` is called once per page and must select
 * with `{ count: 'exact' }` and order by a unique key; rows that move between pages while
 * reading are the caller's to tolerate. Throws the first error.
 */
export async function readAllRows<T>(build: () => RangedQuery<T>, pageRows: number = READ_PAGE_ROWS): Promise<T[]> {
  const rows: T[] = []
  let total: number | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = rows.length
    const { data, error, count } = await build().range(from, from + pageRows - 1)
    if (error) throw error
    const got = data ?? []
    rows.push(...got)
    if (typeof count === 'number') total = count
    if (got.length === 0) break
    if (total !== null ? rows.length >= total : got.length < pageRows) break
  }
  return rows
}
