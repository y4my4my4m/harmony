/**
 * The relay's database half: token checks through GoTrue, membership through the
 * activity_session_* functions of db_schema/migrations/20261117500001_play_together.sql.
 */

import { getSupabaseClient } from '../config/supabase.js'
import { decodeClaims, meetsAssurance } from '../utils/sessionAssurance.js'
import type { Admission, RelayDeps } from './relay.js'
import type { EndReason } from './protocol.js'

/** Verified tokens are trusted for VERIFY_CACHE_MS; at most VERIFY_CACHE_SIZE are kept. */
const VERIFY_CACHE_MS = 30_000
const VERIFY_CACHE_SIZE = 5_000

/** GoTrue refuses a token with 401 or 403; auth-js reports a signed-out session as 400. */
const REFUSED_TOKEN_STATUS = [400, 401, 403]

type Verified = { profileId: string; expiresAt: number | null } | null

export function supabaseRelayDeps(): RelayDeps {
  const supabase = getSupabaseClient()
  const verifiedAt = new Map<string, { at: number; result: Verified }>()

  async function verify(token: string): Promise<Verified> {
    const cached = verifiedAt.get(token)
    if (cached && Date.now() - cached.at < VERIFY_CACHE_MS) return cached.result
    const result = await verifyWithGoTrue(token)
    if (verifiedAt.size >= VERIFY_CACHE_SIZE) verifiedAt.delete(verifiedAt.keys().next().value!)
    // Refusals are not cached: a refreshed session must not wait out a stale refusal.
    if (result) verifiedAt.set(token, { at: Date.now(), result })
    else verifiedAt.delete(token)
    return result
  }

  async function verifyWithGoTrue(token: string): Promise<Verified> {
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error && !REFUSED_TOKEN_STATUS.includes(error.status ?? 0)) throw new Error(`token check: ${error.message}`)
    if (error || !user || !meetsAssurance(user, token)) return null
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .eq('is_local', true)
      .maybeSingle()
    if (profileError) throw new Error(`token profile: ${profileError.message}`)
    if (!profile?.id) return null
    const exp = decodeClaims(token)?.exp
    return { profileId: profile.id as string, expiresAt: typeof exp === 'number' ? exp * 1000 : null }
  }

  return {
    verifyToken: verify,
    async admit(sessionId, profileId) {
      const { data, error } = await supabase.rpc('activity_session_admit', { p_session: sessionId, p_profile: profileId })
      if (error) throw new Error(`activity_session_admit: ${error.message}`)
      return (data ?? { refusal: 'NOT_FOUND' }) as Admission
    },
    async sync(sessionId, members, host) {
      const { data, error } = await supabase.rpc('activity_session_sync', { p_session: sessionId, p_members: members, p_host: host })
      if (error) throw new Error(`activity_session_sync: ${error.message}`)
      return data === true
    },
    async finish(sessionId, reason: EndReason) {
      const { error } = await supabase.rpc('activity_session_finish', { p_session: sessionId, p_reason: reason })
      if (error) throw new Error(`activity_session_finish: ${error.message}`)
    },
  }
}

/** Finishes sessions no relay has touched for 3 minutes. */
export async function reapActivitySessions(): Promise<number> {
  const { data, error } = await getSupabaseClient().rpc('reap_activity_sessions')
  if (error) throw new Error(`reap_activity_sessions: ${error.message}`)
  return Number(data) || 0
}
