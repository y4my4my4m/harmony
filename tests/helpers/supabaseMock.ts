import { vi } from 'vitest'

type QueryResult<T = any> = { data: T | null; error: any | null; count?: number }

interface MockQueryBuilder {
  select: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  upsert: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  neq: ReturnType<typeof vi.fn>
  in: ReturnType<typeof vi.fn>
  is: ReturnType<typeof vi.fn>
  gt: ReturnType<typeof vi.fn>
  lt: ReturnType<typeof vi.fn>
  gte: ReturnType<typeof vi.fn>
  lte: ReturnType<typeof vi.fn>
  like: ReturnType<typeof vi.fn>
  ilike: ReturnType<typeof vi.fn>
  order: ReturnType<typeof vi.fn>
  limit: ReturnType<typeof vi.fn>
  range: ReturnType<typeof vi.fn>
  single: ReturnType<typeof vi.fn>
  maybeSingle: ReturnType<typeof vi.fn>
  then: ReturnType<typeof vi.fn>
}

/**
 * Create a chainable mock query builder that resolves with the given result.
 */
export function createMockQueryBuilder(result: QueryResult = { data: null, error: null }): MockQueryBuilder {
  const builder: any = {}
  const chainMethods = [
    'select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'neq', 'in', 'is', 'gt', 'lt', 'gte', 'lte',
    'like', 'ilike', 'order', 'limit', 'range',
  ]
  for (const method of chainMethods) {
    builder[method] = vi.fn().mockReturnValue(builder)
  }
  builder.single = vi.fn().mockResolvedValue(result)
  builder.maybeSingle = vi.fn().mockResolvedValue(result)
  builder.then = vi.fn((resolve: (r: QueryResult) => void) => resolve(result))

  // Make the builder itself thenable so `await supabase.from('x').select()` works
  Object.defineProperty(builder, 'then', {
    value: (resolve: (r: QueryResult) => void, reject?: (e: any) => void) => {
      return Promise.resolve(result).then(resolve, reject)
    },
    writable: true,
  })

  return builder
}

/**
 * Create a full Supabase client mock with configurable per-table responses.
 */
export function createSupabaseMock(tableResults: Record<string, QueryResult> = {}) {
  const builders: Record<string, MockQueryBuilder> = {}

  const supabase = {
    from: vi.fn((table: string) => {
      if (!builders[table]) {
        builders[table] = createMockQueryBuilder(tableResults[table] || { data: [], error: null })
      }
      return builders[table]
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn(),
      mfa: {
        listFactors: vi.fn().mockResolvedValue({ data: { totp: [] }, error: null }),
        challenge: vi.fn(),
        verify: vi.fn(),
      },
    },
    storage: {
      from: vi.fn().mockReturnValue({
        getPublicUrl: vi.fn((path: string) => ({
          data: { publicUrl: `http://localhost:54321/storage/v1/object/public/test/${path}` },
        })),
        upload: vi.fn().mockResolvedValue({ data: { path: 'uploaded-path' }, error: null }),
        remove: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    },
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnValue({ status: 'SUBSCRIBED' }),
      unsubscribe: vi.fn(),
      send: vi.fn(),
    }),
    removeChannel: vi.fn(),
  }

  return { supabase, builders }
}
