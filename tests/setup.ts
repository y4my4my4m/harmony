import { vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { config } from '@vue/test-utils'

// happy-dom's Node.prototype.nodeName getter returns '' for every node (each subclass defines its
// own nodeName instead). The DOM spec has Node's getter answer for all node types, and browsers
// and jsdom do. DOMPurify >= 3.4.8 reads nodeName through the cached Node.prototype getter
// (clobbering-safe), so under happy-dom it saw every node as unnamed and dropped text. Route the
// base getter to the subclass's own, as a browser's would answer. Test environment only; files
// on `@vitest-environment node` have no DOM and skip it.
if (typeof Node !== 'undefined' && typeof document !== 'undefined') {
  const base = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeName')
  if (base?.get && base.get.call(document.createTextNode('')) !== '#text') {
    const baseGet = base.get
    Object.defineProperty(Node.prototype, 'nodeName', {
      ...base,
      get(this: Node) {
        for (let p = Object.getPrototypeOf(this); p && p !== Node.prototype; p = Object.getPrototypeOf(p)) {
          const own = Object.getOwnPropertyDescriptor(p, 'nodeName')
          if (own?.get) return own.get.call(this)
        }
        return baseGet.call(this)
      },
    })
  }
}

// InlineMarks is markup around its slot: under shallowMount a stub drops the message part inside.
config.global.stubs = { ...config.global.stubs, InlineMarks: false }

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
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_ANON_KEY: 'test-anon-key',
  onSessionRejected: vi.fn(() => () => {}),
  signOutAndForget: vi.fn(async () => {}),
  signOutEverywhere: vi.fn(async () => {}),
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
