import { vi } from 'vitest'
import { webcrypto } from 'node:crypto'

// Polyfill Web Crypto API for Node 18 (natively global in Node 20+)
if (!globalThis.crypto?.subtle) {
  globalThis.crypto = webcrypto as unknown as Crypto
}

vi.stubGlobal('import.meta', {
  env: {
    VITE_SUPABASE_URL: 'http://localhost:54321',
    VITE_SUPABASE_ANON_KEY: 'test-anon-key',
    VITE_DOMAIN: 'harmony.test',
    VITE_HARMONY_ALT_DOMAINS: '',
    VITE_DEV_MODE: 'true',
    MODE: 'test',
  },
})

vi.mock('@/supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn(),
    },
    storage: {
      from: vi.fn().mockReturnValue({
        getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'http://localhost:54321/storage/v1/object/public/test' } }),
        upload: vi.fn().mockResolvedValue({ data: { path: 'test-path' }, error: null }),
      }),
    },
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnValue({ status: 'SUBSCRIBED' }),
      unsubscribe: vi.fn(),
    }),
  },
}))

vi.mock('@/utils/debug', () => ({
  debug: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))
