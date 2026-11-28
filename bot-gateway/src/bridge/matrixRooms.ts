import { supabase } from '../config/supabase.js'
import { absoluteAvatarUrl } from '../utils/avatarUrl.js'
import { configuredBaseUrl } from './bridgeConfig.js'

export interface MatrixRoomBinding { room_id: string; sender_mode: 'ghost' | 'relay' }
export interface MatrixBridgeMember {
  id: string
  username: string
  display_name: string
  avatar_url: string | null
  domain: string
  is_local: true
  nickname: string | null
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MATRIX_ROOM_ID = /^![^\s/\u0000-\u001f\u007f]{1,254}$/

/** The channel's room; room_id null while a managed pair is not bound, or its room was linked elsewhere. */
export async function matrixRoomOf(botId: string, channelId: string): Promise<{ room_id: string | null; sender_mode: 'ghost' | 'relay' }> {
  const { data, error } = await supabase.rpc('matrix_bridge_room', { p_bot_id: botId, p_channel_id: channelId })
  if (!error && data?.room_bound === false && ['ghost', 'relay'].includes(data.sender_mode)) {
    return { room_id: null, sender_mode: data.sender_mode }
  }
  return binding(data, error)
}

function binding(data: any, error: unknown): MatrixRoomBinding {
  if (error || !data || typeof data.room_id !== 'string' || !MATRIX_ROOM_ID.test(data.room_id)
    || !['ghost', 'relay'].includes(data.sender_mode)) throw new Error('Matrix room binding unavailable')
  return { room_id: data.room_id, sender_mode: data.sender_mode }
}

/** A room matrix_bridge_bind_room refuses for good: bound elsewhere, or not the one the pair names. */
export class MatrixRoomRefused extends Error {
  constructor(readonly code: 'room_in_use' | 'room_changed') {
    super(code === 'room_in_use' ? 'The Matrix room is bound to another channel' : 'The channel is paired with another Matrix room')
  }
}

// SQLSTATE of matrix_bridge_bind_room; the caller has checked the room id and the sender mode.
const ROOM_REFUSALS: Record<string, MatrixRoomRefused['code'] | undefined> = { '23505': 'room_in_use', '22023': 'room_changed' }

export async function matrixRoomBinding(
  botId: string,
  channelId: string,
  initial?: MatrixRoomBinding & { room_alias?: string },
): Promise<MatrixRoomBinding> {
  const { data, error } = await supabase.rpc(initial ? 'matrix_bridge_bind_room' : 'matrix_bridge_room', {
    p_bot_id: botId, p_channel_id: channelId,
    ...(initial ? { p_room_id: initial.room_id, p_initial_sender_mode: initial.sender_mode } : {}),
    ...(initial?.room_alias ? { p_room_alias: initial.room_alias } : {}),
  })
  const refusal = initial && error?.code ? ROOM_REFUSALS[error.code] : undefined
  if (refusal) throw new MatrixRoomRefused(refusal)
  return binding(data, error)
}

// matrix_bridge_channel_members answers pages in member id order.
const MEMBER_PAGE = 1000
// Members listed for one channel; a larger channel lists its first MAX_BRIDGE_MEMBERS by id.
export const MAX_BRIDGE_MEMBERS = 10_000

/**
 * Accepted members who can view the channel and did not opt out of Matrix
 * (matrix_bridge_channel_members), read page by page. `until` stops at the first match.
 */
export async function matrixBridgeMembers(
  botId: string,
  channelId: string,
  until?: (member: MatrixBridgeMember) => boolean,
): Promise<MatrixBridgeMember[]> {
  const members: MatrixBridgeMember[] = []
  let after: string | null = null
  while (members.length < MAX_BRIDGE_MEMBERS) {
    const page = await memberPage(botId, channelId, after)
    members.push(...page)
    if (until && page.some(until)) break
    if (page.length < MEMBER_PAGE) break
    after = page[page.length - 1].id
  }
  return members
}

/** The member alone, under the rules of the list; none when it would not name them. */
export async function matrixBridgeMember(botId: string, channelId: string, userId: string): Promise<MatrixBridgeMember[]> {
  const { data, error } = await supabase.rpc('matrix_bridge_channel_member', {
    p_bot_id: botId, p_channel_id: channelId, p_user_id: userId,
  })
  const members = memberRows(data, error)
  if (members.length > 1 || members.some(row => row.id !== userId.toLowerCase())) throw new Error('Matrix member consent unavailable')
  return members
}

export interface MatrixSendCheck {
  platform: 'matrix' | null
  room_id: string | null
  sender_mode: 'ghost' | 'relay' | null
  messages_encrypted: boolean | null
  relay_allowed: boolean | null
  member: MatrixBridgeMember | null
}
export const NO_MATRIX_BINDING: MatrixSendCheck = {
  platform: null, room_id: null, sender_mode: null, messages_encrypted: null, relay_allowed: null, member: null,
}

/**
 * matrix_bridge_send_check: the channel's binding, room, sender mode and encryption, and with
 * `userId` that member's consent and profile. `scoped` is false for an install without a channel
 * list, whose sight of the channel the caller checks. Throws on anything else than a whole answer.
 */
export async function matrixSendCheck(
  botId: string,
  channelId: string,
  userId?: string,
): Promise<{ check: MatrixSendCheck; scoped: boolean }> {
  const { data, error } = await supabase.rpc('matrix_bridge_send_check', {
    p_bot_id: botId, p_channel_id: channelId, p_user_id: userId ?? null,
  })
  if (!error && data?.platform === null) return { check: NO_MATRIX_BINDING, scoped: true }
  if (error || data?.platform !== 'matrix' || typeof data.messages_encrypted !== 'boolean'
    || !['ghost', 'relay'].includes(data.sender_mode)
    || (data.room_id !== null && (typeof data.room_id !== 'string' || !MATRIX_ROOM_ID.test(data.room_id)))
    || (userId === undefined ? data.relay_allowed !== null : typeof data.relay_allowed !== 'boolean')
    || (data.scoped !== undefined && data.scoped !== false)) throw new Error('Matrix send check unavailable')
  const [member = null] = data.member === null ? [] : memberRows([data.member], null)
  if (member && member.id !== userId?.toLowerCase()) throw new Error('Matrix send check unavailable')
  return {
    check: {
      platform: 'matrix', room_id: data.room_id, sender_mode: data.sender_mode,
      messages_encrypted: data.messages_encrypted, relay_allowed: data.relay_allowed, member,
    },
    scoped: data.scoped !== false,
  }
}

async function memberPage(botId: string, channelId: string, after: string | null): Promise<MatrixBridgeMember[]> {
  const { data, error } = await supabase.rpc('matrix_bridge_channel_members', {
    p_bot_id: botId, p_channel_id: channelId, p_limit: MEMBER_PAGE, p_after: after,
  })
  return memberRows(data, error)
}

function memberRows(data: any, error: unknown): MatrixBridgeMember[] {
  if (error || !Array.isArray(data) || data.some(row => !row || !UUID.test(row.id)
    || typeof row.username !== 'string' || !row.username.trim() || row.username.length > 100
    || (row.display_name != null && (typeof row.display_name !== 'string' || row.display_name.length > 100))
    || (row.avatar_url != null && (typeof row.avatar_url !== 'string' || row.avatar_url.length > 2048))
    || (row.nickname != null && (typeof row.nickname !== 'string' || row.nickname.length > 100))
    || (row.domain != null && (typeof row.domain !== 'string' || row.domain.length > 255 || /[\s/@?#]/.test(row.domain)))
    || row.is_local !== true)
    || new Set(data.map(row => row.id)).size !== data.length) throw new Error('Matrix member consent unavailable')
  let domain = ''
  try { domain = new URL(configuredBaseUrl() || process.env.PUBLIC_URL || process.env.SUPABASE_URL || '').host } catch { /* No public handle configured. */ }
  return data.map(row => ({
    id: row.id, username: row.username, display_name: row.nickname || row.display_name || row.username,
    avatar_url: row.avatar_url || null, domain: row.domain || domain, is_local: true, nickname: row.nickname || null,
  }))
}

export function publicMatrixBridgeMembers(members: MatrixBridgeMember[]): MatrixBridgeMember[] {
  return members.map(row => ({ ...row, avatar_url: absoluteAvatarUrl(row.avatar_url) || null }))
}
