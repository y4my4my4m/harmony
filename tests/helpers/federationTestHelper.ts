/**
 * Helper for federation backend integration tests.
 * Creates a supertest-wrapped Express app with mocked dependencies.
 */
import { vi } from 'vitest'

/**
 * Create a mock config object for federation backend tests.
 */
export function createMockConfig(overrides: Record<string, any> = {}) {
  return {
    PORT: 3001,
    NODE_ENV: 'test',
    INSTANCE_DOMAIN: 'harmony.test',
    INSTANCE_NAME: 'Test Harmony',
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_ANON_KEY: 'test-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:54322/postgres',
    USE_PGBOSS_QUEUE: false,
    CORS_ORIGIN: 'http://localhost:5173',
    ...overrides,
  }
}

/**
 * Create a mock Supabase service-role client for federation tests.
 */
export function createMockSupabaseService() {
  const mockQueryBuilder: any = {}
  const chainMethods = [
    'select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'neq', 'in', 'is', 'gt', 'lt', 'gte', 'lte',
    'like', 'ilike', 'order', 'limit', 'range', 'or', 'not',
    'filter', 'match', 'textSearch',
  ]
  for (const method of chainMethods) {
    mockQueryBuilder[method] = vi.fn().mockReturnValue(mockQueryBuilder)
  }
  mockQueryBuilder.single = vi.fn().mockResolvedValue({ data: null, error: null })
  mockQueryBuilder.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })

  Object.defineProperty(mockQueryBuilder, 'then', {
    value: (resolve: any, reject?: any) => Promise.resolve({ data: [], error: null }).then(resolve, reject),
    writable: true,
    configurable: true,
  })

  return {
    from: vi.fn().mockReturnValue(mockQueryBuilder),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    storage: {
      from: vi.fn().mockReturnValue({
        getPublicUrl: vi.fn((path: string) => ({
          data: { publicUrl: `http://localhost:54321/storage/v1/object/public/test/${path}` },
        })),
      }),
    },
    _queryBuilder: mockQueryBuilder,
  }
}
