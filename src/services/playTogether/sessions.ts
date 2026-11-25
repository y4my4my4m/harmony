import { supabase } from '@/supabase'
import type { SessionContext } from '../../../activities/sdk/protocol'

/** Play-together sessions (db_schema/migrations/20261117500001_play_together.sql). */

export interface SessionMember {
  id: string
  username: string | null
  display_name: string | null
  avatar_url: string | null
}

export interface ActivitySession {
  id: string
  app_id: string
  app_name: string
  min_players: number
  max_players: number
  context: SessionContext
  conversation_id: string | null
  channel_id: string | null
  server_id: string | null
  started_by: string | null
  host_id: string | null
  message_id: string | null
  status: 'active' | 'ended'
  started_at: string
  ended_at: string | null
  members: SessionMember[]
  played_count: number
  /** Why the caller cannot join now: NOT_IN_CALL, CANNOT_SEND or MEMBER_TIMED_OUT. */
  refusal?: string | null
}

/** Where a session runs: a conversation or a channel. */
export type ActivityTarget =
  | { kind: 'conversation'; id: string }
  | { kind: 'channel'; id: string; serverId: string; voice: boolean }

export function targetKey(target: ActivityTarget): string {
  return `${target.kind === 'conversation' ? 'c' : 'ch'}:${target.id}`
}

export function sessionTargetKey(session: Pick<ActivitySession, 'conversation_id' | 'channel_id'>): string {
  return session.conversation_id ? `c:${session.conversation_id}` : `ch:${session.channel_id}`
}

export class ActivityError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code)
    this.name = 'ActivityError'
  }
}

const CODES = [
  'ACTIVITY_APP_UNAVAILABLE', 'ACTIVITY_CONTEXT_UNSUPPORTED', 'ACTIVITY_RATE_LIMITED', 'ACTIVITY_CONTEXT',
  'NOT_LOCAL_ACCOUNT', 'NOT_FOUND', 'SERVER_NOT_LOCAL', 'CHANNEL_TYPE', 'NOT_IN_CALL', 'CANNOT_SEND',
]

function raise(error: { message: string } | null): void {
  if (!error) return
  const code = CODES.find((c) => error.message === c || error.message.startsWith(`${c}:`)) ?? 'UNKNOWN'
  throw new ActivityError(code, error.message)
}

function targetArgs(target: ActivityTarget): { p_conversation: string | null; p_channel: string | null } {
  return target.kind === 'conversation'
    ? { p_conversation: target.id, p_channel: null }
    : { p_conversation: null, p_channel: target.id }
}

export async function startSession(appId: string, target: ActivityTarget): Promise<{ session: ActivitySession; existing: boolean }> {
  const { data, error } = await supabase.rpc('start_activity_session', { p_app: appId, ...targetArgs(target) })
  raise(error)
  return data as { session: ActivitySession; existing: boolean }
}

export async function getSessions(target: ActivityTarget): Promise<ActivitySession[]> {
  const { data, error } = await supabase.rpc('get_activity_sessions', targetArgs(target))
  raise(error)
  return (data as ActivitySession[] | null) ?? []
}

export async function getSession(id: string): Promise<ActivitySession | null> {
  const { data, error } = await supabase.rpc('get_activity_session', { p_session: id })
  raise(error)
  return (data as ActivitySession | null) ?? null
}
