/**
 * The Realtime client takes its token from realtimeAccessToken, not from supabase-js's default
 * callback, which answers the anon key while a refresh fails.
 */

import { describe, it, expect, vi } from 'vitest'

vi.unmock('@/supabase')

const { created } = vi.hoisted(() => ({
  created: { options: undefined as any, client: undefined as any },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: any) => {
    created.options = options
    created.client = { auth: { getSession: vi.fn() } }
    return created.client
  },
}))

vi.mock('@/services/instanceConfig', () => ({
  getStoredInstance: () => ({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon-key' }),
  isTauriRuntime: () => false,
}))

await import('@/supabase')

describe('supabase client realtime token', () => {
  it('keeps the user token across a failed refresh and falls back to the anon key when signed out', async () => {
    const accessToken = created.options?.realtime?.accessToken as () => Promise<string>
    expect(typeof accessToken).toBe('function')
    const getSession = created.client.auth.getSession as ReturnType<typeof vi.fn>
    getSession
      .mockResolvedValueOnce({ data: { session: { access_token: 'user-1' } }, error: null })
      .mockResolvedValueOnce({ data: { session: null }, error: { name: 'AuthRetryableFetchError' } })
      .mockResolvedValueOnce({ data: { session: null }, error: null })
    expect(await accessToken()).toBe('user-1')
    expect(await accessToken()).toBe('user-1')
    expect(await accessToken()).toBe('anon-key')
  })
})
