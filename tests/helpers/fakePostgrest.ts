// Minimal PostgREST stand-in for supabase-js query chains.
//
// Reproduces the two response shapes the reblog paths depend on:
//   single()      -> PGRST116 error when the match count is not exactly 1
//   maybeSingle() -> {data:null,error:null} on 0 rows, PGRST116 error on >1
// postgrest-js only swallows PGRST116 when the details say "0 rows"; a >1-row
// maybeSingle returns data null AND an error.

export interface FakeOp {
  fn: string
  args: any[]
}

export interface FakeCall {
  table: string
  ops: FakeOp[]
}

const CHAIN_METHODS = [
  'select', 'insert', 'update', 'delete', 'upsert',
  'eq', 'neq', 'in', 'is', 'not', 'or', 'filter', 'match', 'contains',
  'order', 'limit', 'range', 'lt', 'lte', 'gt', 'gte',
]

// `metadata->>key` reads the JSON member; anything else is a plain column.
export function getField(row: any, column: string): any {
  const arrow = column.indexOf('->>')
  if (arrow === -1) return row?.[column]
  const base = column.slice(0, arrow)
  const key = column.slice(arrow + 3).replace(/^["']|["']$/g, '')
  return row?.[base]?.[key]
}

export function createFakePostgrest(tables: Record<string, any[]>) {
  const calls: FakeCall[] = []
  let seq = 0

  const run = (table: string, ops: FakeOp[]): any[] => {
    const rows = tables[table] ?? (tables[table] = [])
    const insertOp = ops.find(o => o.fn === 'insert')
    if (insertOp) {
      const payloads = Array.isArray(insertOp.args[0]) ? insertOp.args[0] : [insertOp.args[0]]
      const inserted = payloads.map((p: any) => ({ id: `${table}-${++seq}`, ...p }))
      rows.push(...inserted)
      return inserted
    }

    const eqs = ops.filter(o => o.fn === 'eq')
    const matched = rows.filter(r => eqs.every(f => getField(r, f.args[0]) === f.args[1]))

    const updateOp = ops.find(o => o.fn === 'update')
    if (updateOp) {
      matched.forEach(r => Object.assign(r, updateOp.args[0]))
      return matched
    }
    if (ops.some(o => o.fn === 'delete')) {
      matched.forEach(r => rows.splice(rows.indexOf(r), 1))
      return matched
    }
    return matched
  }

  const from = (table: string) => {
    const ops: FakeOp[] = []
    calls.push({ table, ops })
    const builder: any = {}
    for (const m of CHAIN_METHODS) {
      builder[m] = (...args: any[]) => {
        ops.push({ fn: m, args })
        return builder
      }
    }
    builder.single = () => {
      ops.push({ fn: 'single', args: [] })
      const rows = run(table, ops)
      if (rows.length === 1) return Promise.resolve({ data: rows[0], error: null })
      return Promise.resolve({
        data: null,
        error: {
          code: 'PGRST116',
          message: 'JSON object requested, multiple (or no) rows returned',
          details: `Results contain ${rows.length} rows`,
        },
      })
    }
    builder.maybeSingle = () => {
      ops.push({ fn: 'maybeSingle', args: [] })
      const rows = run(table, ops)
      if (rows.length === 1) return Promise.resolve({ data: rows[0], error: null })
      if (rows.length === 0) return Promise.resolve({ data: null, error: null })
      return Promise.resolve({
        data: null,
        error: {
          code: 'PGRST116',
          message: 'JSON object requested, multiple (or no) rows returned',
          details: `Results contain ${rows.length} rows`,
        },
      })
    }
    builder.then = (resolve: any, reject: any) => {
      const rows = run(table, ops)
      return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject)
    }
    return builder
  }

  return { from, calls, tables }
}
