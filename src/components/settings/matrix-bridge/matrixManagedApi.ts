/** RPCs of the managed Matrix bridge of a server (matrix_bridges); each needs MANAGE_SERVER. */
import { supabase } from '@/supabase'
import { BridgeUnavailableError, raise, rememberSetupCode, type IssuedSetupCode } from '@/components/settings/discord-bridge/bridgeApi'
import { bridgeErrorKey } from '@/components/settings/discord-bridge/bridgeErrors'
import type { BridgeMode } from '@/utils/discordBridgeSetup'
import {
  parseMatrixBridgeState,
  type MatrixBridgeState,
  type MatrixPairDirection,
  type MatrixSenderMode,
} from '@/utils/matrixBridgeSetup'
import { InvalidMatrixBridgeResponse } from './matrixBridgeApi'

function stateOf(data: unknown): MatrixBridgeState | null {
  const state = parseMatrixBridgeState(data)
  if (state === undefined) throw new InvalidMatrixBridgeResponse()
  return state
}

function bridgeOf(data: unknown): MatrixBridgeState {
  const state = stateOf(data)
  if (!state) throw new InvalidMatrixBridgeResponse()
  return state
}

/** Null without a bridge. Throws BridgeUnavailableError on an instance before 1.9.9. */
export async function fetchMatrixBridgeState(serverId: string): Promise<MatrixBridgeState | null> {
  const { data, error } = await supabase.rpc('matrix_bridge_state', { p_server_id: serverId })
  raise(error)
  return stateOf(data)
}

export async function createMatrixBridge(serverId: string, mode: BridgeMode): Promise<MatrixBridgeState> {
  const { data, error } = await supabase.rpc('matrix_bridge_create', { p_server_id: serverId, p_mode: mode })
  raise(error)
  return bridgeOf(data)
}

export async function createMatrixSetupCode(bridgeId: string): Promise<IssuedSetupCode> {
  const { data, error } = await supabase.rpc('matrix_bridge_setup_code', { p_bridge_id: bridgeId })
  raise(error)
  const code = (data as { code?: unknown } | null)?.code
  if (typeof code !== 'string' || !code) throw new InvalidMatrixBridgeResponse()
  return rememberSetupCode(bridgeId, code)
}

/** Pairs a channel with a room (`!id` or `#alias:server`), or changes the pair it has. */
export async function pairMatrixRoom(
  bridgeId: string,
  channelId: string,
  room: string,
  direction: MatrixPairDirection,
  senderMode: MatrixSenderMode,
): Promise<MatrixBridgeState> {
  const { data, error } = await supabase.rpc('matrix_bridge_pair', {
    p_bridge_id: bridgeId,
    p_channel_id: channelId,
    p_room: room,
    p_direction: direction,
    p_sender_mode: senderMode,
  })
  raise(error)
  return bridgeOf(data)
}

export async function unpairMatrixRoom(bridgeId: string, channelId: string): Promise<MatrixBridgeState> {
  const { data, error } = await supabase.rpc('matrix_bridge_unpair', { p_bridge_id: bridgeId, p_channel_id: channelId })
  raise(error)
  return bridgeOf(data)
}

/** Stores a hosted bridge's account; the token goes to Vault and never comes back. */
export async function setMatrixAccount(bridgeId: string, homeserverUrl: string, accessToken: string): Promise<MatrixBridgeState> {
  const { data, error } = await supabase.rpc('matrix_bridge_set_account', {
    p_bridge_id: bridgeId,
    p_homeserver_url: homeserverUrl,
    p_access_token: accessToken,
  })
  raise(error)
  return bridgeOf(data)
}

export interface MatrixRoomCode {
  code: string
  issuedAt: number
  /** The instance's Matrix account, to invite to the room; null until its service reported one. */
  userId: string | null
}

/** A code that links the room it is posted in with the channel; it replaces the channel's earlier one. */
export async function createMatrixRoomCode(
  bridgeId: string,
  channelId: string,
  direction: MatrixPairDirection,
  senderMode: MatrixSenderMode,
): Promise<MatrixRoomCode> {
  const { data, error } = await supabase.rpc('matrix_bridge_room_code', {
    p_bridge_id: bridgeId,
    p_channel_id: channelId,
    p_direction: direction,
    p_sender_mode: senderMode,
  })
  raise(error)
  const row = (data ?? {}) as { code?: unknown; user_id?: unknown }
  if (typeof row.code !== 'string' || !row.code) throw new InvalidMatrixBridgeResponse()
  return { code: row.code, issuedAt: Date.now(), userId: typeof row.user_id === 'string' && row.user_id ? row.user_id : null }
}

export interface MatrixOffers {
  hosted: boolean
  instance: boolean
}

/** What the instance runs for its communities; nothing where it cannot be read. */
export async function fetchMatrixOffers(): Promise<MatrixOffers> {
  const { data, error } = await supabase.rpc('matrix_bridge_offers')
  const row = (error ? {} : (data ?? {})) as { hosted?: unknown; instance?: unknown }
  return { hosted: row.hosted === true, instance: row.instance === true }
}

export async function deleteMatrixBridge(bridgeId: string): Promise<void> {
  const { error } = await supabase.rpc('matrix_bridge_delete', { p_bridge_id: bridgeId })
  raise(error)
}

/** The locale key for a failed request; `taken` names what a unique violation (23505) means there. */
export function matrixManagedErrorKey(error: unknown, fallback: string, taken?: string): string {
  if (error instanceof BridgeUnavailableError) return 'matrixBridge.errors.unavailable'
  const code = (error as { code?: unknown } | null)?.code
  // The switch of the mode is off, or its limit is reached.
  if (code === '0A000') return 'matrixBridge.errors.notOffered'
  if (code === '54000') return 'matrixBridge.errors.full'
  if (code === '23505' && taken) return taken
  if (code === 'P0002') return 'matrixBridge.errors.gone'
  return bridgeErrorKey(error, fallback)
}
