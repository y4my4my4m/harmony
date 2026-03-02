/**
 * Database test helper for integration tests against local Supabase PostgreSQL.
 *
 * Requires the local Supabase stack running (dev/docker-compose.yml).
 * Uses direct pg connections for transaction-based isolation.
 *
 * Set environment variables:
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres
 */

export interface DbTestContext {
  query: (sql: string, params?: any[]) => Promise<any[]>
  queryOne: (sql: string, params?: any[]) => Promise<any | null>
}

let pgModule: any = null

async function getPg() {
  if (!pgModule) {
    try {
      pgModule = await import('pg')
    } catch {
      throw new Error(
        'pg package is required for database tests. Install with: npm install --save-dev pg @types/pg',
      )
    }
  }
  return pgModule
}

/**
 * Run a test function inside a rolled-back transaction for isolation.
 */
export async function withTestTransaction(fn: (ctx: DbTestContext) => Promise<void>): Promise<void> {
  const pg = await getPg()
  const connectionString = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/postgres'
  const client = new pg.Client({ connectionString })

  await client.connect()
  await client.query('BEGIN')

  try {
    const ctx: DbTestContext = {
      query: async (sql, params) => {
        const res = await client.query(sql, params)
        return res.rows
      },
      queryOne: async (sql, params) => {
        const res = await client.query(sql, params)
        return res.rows[0] || null
      },
    }
    await fn(ctx)
  } finally {
    await client.query('ROLLBACK')
    await client.end()
  }
}

/**
 * Check if the database is reachable. Skip tests if not.
 */
export async function isDatabaseAvailable(): Promise<boolean> {
  try {
    const pg = await getPg()
    const connectionString = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/postgres'
    const client = new pg.Client({ connectionString })
    await client.connect()
    await client.query('SELECT 1')
    await client.end()
    return true
  } catch {
    return false
  }
}
