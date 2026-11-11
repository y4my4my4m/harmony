import { supabase } from '@/supabase'

type Listener = (token: string) => void

const listeners = new Set<Listener>()
let bound = false

/**
 * The token realtime-js sends with joins and `access_token` pushes (`RealtimeClient.accessTokenValue`,
 * realtime-js 2.84). Empty when none is set.
 */
export function currentRealtimeToken(): string {
  return String((supabase as any).realtime?.accessTokenValue ?? '')
}

/**
 * Calls `listener` with each member access token auth-js hands out (TOKEN_REFRESHED, SIGNED_IN)
 * while Realtime holds it. A topic refused on another token (the anon key, an expired token) can
 * join on this one.
 *
 * supabase-js 2.84 registers its own auth listener in the client constructor, ahead of this one,
 * and hands the token to `realtime.setAuth` there. Dispatch runs after the auth callback returns
 * (auth-js holds its lock while listeners run) and is skipped when Realtime holds another token
 * by then, a sign-out in between included.
 */
export function onMemberToken(listener: Listener): () => void {
  bind()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function bind(): void {
  if (bound) return
  bound = true
  supabase.auth.onAuthStateChange((event, session) => {
    if (event !== 'TOKEN_REFRESHED' && event !== 'SIGNED_IN') return
    const token = session?.access_token
    if (!token) return
    setTimeout(() => {
      if (currentRealtimeToken() !== token) return
      for (const l of [...listeners]) {
        try {
          l(token)
        } catch {
          /* one listener's failure does not stop the others */
        }
      }
    }, 0)
  })
}
