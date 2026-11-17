/**
 * Matrix bridge manager RPCs. get_server_matrix_bridges and set_matrix_bridge_sender_mode need
 * MANAGE_SERVER; configure_matrix_bridge also needs the caller to own the bot.
 */
import { supabase } from '@/supabase'

export const MATRIX_SENDER_MODES = ['ghost', 'relay'] as const
export type MatrixSenderMode = (typeof MATRIX_SENDER_MODES)[number]

/** One bot/channel binding; room_id is null until the bridge service binds a room. */
export interface MatrixBridgePair {
  bot_id: string
  channel_id: string
  channel_name: string
  room_id: string | null
  sender_mode: MatrixSenderMode
}

export class InvalidMatrixBridgeResponse extends Error {
  constructor() {
    super('Invalid Matrix bridge response')
  }
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0

export function isMatrixSenderMode(value: unknown): value is MatrixSenderMode {
  return typeof value === 'string' && (MATRIX_SENDER_MODES as readonly string[]).includes(value)
}

export function isMatrixBridgePair(value: unknown): value is MatrixBridgePair {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return nonEmpty(row.bot_id) && nonEmpty(row.channel_id) && nonEmpty(row.channel_name)
    && (row.room_id === null || nonEmpty(row.room_id))
    && isMatrixSenderMode(row.sender_mode)
}

function pairOf(row: MatrixBridgePair): MatrixBridgePair {
  const { bot_id, channel_id, channel_name, room_id, sender_mode } = row
  return { bot_id, channel_id, channel_name, room_id, sender_mode }
}

type RpcResult = { data: unknown; error: unknown } | null | undefined

function dataOf(result: RpcResult): unknown {
  if (!result || result.error) throw result?.error ?? new InvalidMatrixBridgeResponse()
  return result.data
}

export async function fetchServerMatrixBridges(serverId: string): Promise<MatrixBridgePair[]> {
  const data = dataOf(await supabase.rpc('get_server_matrix_bridges', { p_server_id: serverId }))
  if (!Array.isArray(data) || !data.every(isMatrixBridgePair)) throw new InvalidMatrixBridgeResponse()
  return data.map(pairOf)
}

/** The saved pair; a jsonb object, or a one-row set from older definitions. */
export async function setMatrixBridgeSenderMode(botId: string, channelId: string, mode: MatrixSenderMode): Promise<MatrixBridgePair> {
  const data = dataOf(await supabase.rpc('set_matrix_bridge_sender_mode', {
    p_bot_id: botId,
    p_channel_id: channelId,
    p_sender_mode: mode,
  }))
  const row = Array.isArray(data)
    ? data.find(item => isMatrixBridgePair(item) && item.bot_id === botId && item.channel_id === channelId)
    : data
  if (!isMatrixBridgePair(row) || row.bot_id !== botId || row.channel_id !== channelId) throw new InvalidMatrixBridgeResponse()
  return pairOf(row)
}

/** Replaces the server's bindings of the bot with `channelIds`. */
export async function configureMatrixBridge(botId: string, serverId: string, channelIds: readonly string[]): Promise<boolean> {
  const data = dataOf(await supabase.rpc('configure_matrix_bridge', {
    p_bot_id: botId,
    p_server_id: serverId,
    p_channel_ids: [...channelIds],
  }))
  return data === true
}

/** Removes the server's bindings of the bot. */
export async function unconfigureMatrixBridge(botId: string, serverId: string): Promise<boolean> {
  const data = dataOf(await supabase.rpc('unconfigure_matrix_bridge', { p_bot_id: botId, p_server_id: serverId }))
  return data === true
}
