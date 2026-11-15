/** Rows asked per request. PostgREST answers at most db-max-rows, which may be fewer. */
export const LIST_PAGE = 1000
export const LIST_MAX_ROWS = 10_000

type PageResult<T> = { data: T[] | null; error: { message: string } | null }

/**
 * Every row of a select ordered by id, read by keyset: `page(afterId)` answers the rows whose
 * id follows afterId. Ends on an empty page, not on a short one. `truncated` when more than
 * LIST_MAX_ROWS rows exist.
 */
export async function selectAllById<T extends { id: string }>(
  page: (afterId: string | null) => PromiseLike<PageResult<T>>,
): Promise<{ rows: T[]; truncated: boolean; error: { message: string } | null }> {
  const rows: T[] = []
  let after: string | null = null
  for (;;) {
    const { data, error } = await page(after)
    if (error) return { rows, truncated: false, error }
    if (!data || data.length === 0) return { rows, truncated: false, error: null }
    rows.push(...data)
    if (rows.length > LIST_MAX_ROWS) return { rows: rows.slice(0, LIST_MAX_ROWS), truncated: true, error: null }
    after = data[data.length - 1].id
  }
}
