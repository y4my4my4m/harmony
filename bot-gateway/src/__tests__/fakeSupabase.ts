/**
 * In-memory stand-in for the supabase-js query builder over plain row arrays. Filters apply;
 * column lists, ordering and JSON-path filters do not. Every builder is a thenable resolving to
 * { data, error }, as in supabase-js.
 */

export type Row = Record<string, any>

export interface FakeResult {
  data: any
  error: { message: string; code?: string } | null
}

export interface FakeWrite {
  table: string
  op: 'insert' | 'update' | 'delete' | 'upsert'
  rows: Row[]
}

export class FakeDb {
  readonly tables: Record<string, Row[]>
  readonly writes: FakeWrite[] = []
  // Table name -> error every query on that table returns.
  readonly failures: Record<string, { message: string; code?: string }> = {}
  private seq = 0

  constructor(tables: Record<string, Row[]> = {}) {
    this.tables = Object.fromEntries(
      Object.entries(tables).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]),
    )
  }

  from(table: string): FakeQuery {
    return new FakeQuery(this, table)
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= [])
  }

  nextId(): string {
    this.seq += 1
    return `00000000-0000-0000-0000-${this.seq.toString(16).padStart(12, 'f')}`
  }

  writesTo(table: string, op?: FakeWrite['op']): FakeWrite[] {
    return this.writes.filter((w) => w.table === table && (!op || w.op === op))
  }
}

export class FakeQuery implements PromiseLike<FakeResult> {
  private op: 'select' | FakeWrite['op'] = 'select'
  private payload: any
  private filters: Array<(row: Row) => boolean> = []
  private limitN: number | null = null

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(_columns?: string, _options?: unknown): this {
    return this
  }

  insert(values: Row | Row[]): this {
    this.op = 'insert'
    this.payload = values
    return this
  }

  upsert(values: Row | Row[], _options?: unknown): this {
    this.op = 'upsert'
    this.payload = values
    return this
  }

  update(values: Row): this {
    this.op = 'update'
    this.payload = values
    return this
  }

  delete(): this {
    this.op = 'delete'
    return this
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value)
    return this
  }

  neq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] !== value)
    return this
  }

  is(column: string, value: unknown): this {
    this.filters.push((row) => (value === null ? row[column] == null : row[column] === value))
    return this
  }

  in(column: string, values: readonly unknown[]): this {
    this.filters.push((row) => values.includes(row[column]))
    return this
  }

  lt(column: string, value: any): this {
    this.filters.push((row) => row[column] < value)
    return this
  }

  gt(column: string, value: any): this {
    this.filters.push((row) => row[column] > value)
    return this
  }

  filter(): this {
    return this
  }

  order(): this {
    return this
  }

  limit(n: number): this {
    this.limitN = n
    return this
  }

  async maybeSingle(): Promise<FakeResult> {
    const result = await this.exec()
    if (result.error) return result
    if (result.data.length > 1) {
      return { data: null, error: { code: 'PGRST116', message: 'multiple rows returned' } }
    }
    return { data: result.data[0] ?? null, error: null }
  }

  async single(): Promise<FakeResult> {
    const result = await this.exec()
    if (result.error) return result
    if (result.data.length !== 1) {
      return { data: null, error: { code: 'PGRST116', message: `${result.data.length} rows returned` } }
    }
    return { data: result.data[0], error: null }
  }

  then<T1 = FakeResult, T2 = never>(
    onfulfilled?: ((value: FakeResult) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this.exec().then(onfulfilled, onrejected)
  }

  private async exec(): Promise<FakeResult> {
    const failure = this.db.failures[this.table]
    if (failure) return { data: null, error: failure }

    const all = this.db.rows(this.table)
    const matches = (row: Row) => this.filters.every((f) => f(row))
    const copy = (row: Row) => ({ ...row })

    switch (this.op) {
      case 'select': {
        let rows = all.filter(matches)
        if (this.limitN !== null) rows = rows.slice(0, this.limitN)
        return { data: rows.map(copy), error: null }
      }
      case 'insert':
      case 'upsert': {
        const input: Row[] = Array.isArray(this.payload) ? this.payload : [this.payload]
        const rows = input.map((values) => ({ id: this.db.nextId(), ...values }))
        all.push(...rows)
        this.db.writes.push({ table: this.table, op: this.op, rows: rows.map(copy) })
        return { data: rows.map(copy), error: null }
      }
      case 'update': {
        const rows = all.filter(matches)
        for (const row of rows) Object.assign(row, this.payload)
        this.db.writes.push({ table: this.table, op: 'update', rows: rows.map(copy) })
        return { data: rows.map(copy), error: null }
      }
      case 'delete': {
        const rows = all.filter(matches)
        this.db.tables[this.table] = all.filter((row) => !matches(row))
        this.db.writes.push({ table: this.table, op: 'delete', rows: rows.map(copy) })
        return { data: rows.map(copy), error: null }
      }
    }
  }
}
