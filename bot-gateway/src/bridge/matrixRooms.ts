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

export async function matrixRoomBinding(botId: string, channelId: string, initial?: MatrixRoomBinding): Promise<MatrixRoomBinding> {
  const { data, error } = await supabase.rpc(initial ? 'matrix_bridge_bind_room' : 'matrix_bridge_room', {
    p_bot_id: botId, p_channel_id: channelId,
    ...(initial ? { p_room_id: initial.room_id, p_initial_sender_mode: initial.sender_mode } : {}),
  })
  if (error || !data || typeof data.room_id !== 'string' || !MATRIX_ROOM_ID.test(data.room_id)
    || !['ghost', 'relay'].includes(data.sender_mode)) throw new Error('Matrix room binding unavailable')
  return { room_id: data.room_id, sender_mode: data.sender_mode }
}

/** Only currently consenting, channel-visible local members are returned by the service RPC. */
export async function matrixBridgeMembers(botId: string, channelId: string): Promise<MatrixBridgeMember[]> {
  const { data, error } = await supabase.rpc('matrix_bridge_channel_members', { p_bot_id: botId, p_channel_id: channelId })
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
