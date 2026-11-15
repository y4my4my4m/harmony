import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Token callback of the Realtime client. Mirrors `SupabaseClient#_getAccessToken`
 * (supabase-js 2.84), which answers the anon key whenever `getSession()` returns no session.
 *
 * Deviation: `getSession()` also returns no session, with an error, when a refresh fails and
 * the stored session waits for the next attempt (network error, 502-504). realtime-js sends
 * whatever this returns to every joined channel and puts it in every later join, and Realtime
 * stops or refuses each private topic on the anon key. In that state the last access token is
 * returned instead. No session and no error means signed out: the anon key, as upstream.
 */
export function realtimeAccessToken(client: () => SupabaseClient, anonKey: string): () => Promise<string> {
  let last: string | null = null
  return async () => {
    const { data, error } = await client().auth.getSession()
    if (data.session) {
      last = data.session.access_token
      return last
    }
    if (error && last) return last
    last = null
    return anonKey
  }
}
