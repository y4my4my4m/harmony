/**
 * Realtime's token callback. getSession() answers { session: null, error } while a refresh
 * fails and the stored session waits for the next attempt (auth-js 2.84 __loadSession); the
 * anon key then closes every private topic, so the last access token is kept.
 */

import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { realtimeAccessToken } from '@/services/realtimeAccessToken'

const ANON = 'anon-key'

function clientWith(getSession: ReturnType<typeof vi.fn>): () => SupabaseClient {
  const client = { auth: { getSession } } as unknown as SupabaseClient
  return () => client
}

const session = (token: string) => ({ data: { session: { access_token: token } }, error: null })
const refreshFailed = () => ({ data: { session: null }, error: { name: 'AuthRetryableFetchError', status: 0 } })
const signedOut = () => ({ data: { session: null }, error: null })

describe('realtimeAccessToken', () => {
  it('answers the session token', async () => {
    const getSession = vi.fn().mockResolvedValue(session('user-1'))
    expect(await realtimeAccessToken(clientWith(getSession), ANON)()).toBe('user-1')
  })

  it('keeps the last token while a refresh fails', async () => {
    const getSession = vi.fn()
      .mockResolvedValueOnce(session('user-1'))
      .mockResolvedValueOnce(refreshFailed())
      .mockResolvedValueOnce(refreshFailed())
      .mockResolvedValueOnce(session('user-2'))
    const token = realtimeAccessToken(clientWith(getSession), ANON)
    expect(await token()).toBe('user-1')
    expect(await token()).toBe('user-1')
    expect(await token()).toBe('user-1')
    expect(await token()).toBe('user-2')
  })

  it('answers the anon key once signed out, and after', async () => {
    const getSession = vi.fn()
      .mockResolvedValueOnce(session('user-1'))
      .mockResolvedValueOnce(signedOut())
      .mockResolvedValueOnce(refreshFailed())
    const token = realtimeAccessToken(clientWith(getSession), ANON)
    expect(await token()).toBe('user-1')
    expect(await token()).toBe(ANON)
    expect(await token()).toBe(ANON)
  })

  it('answers the anon key when no token was ever seen', async () => {
    const getSession = vi.fn().mockResolvedValue(refreshFailed())
    expect(await realtimeAccessToken(clientWith(getSession), ANON)()).toBe(ANON)
  })
})
