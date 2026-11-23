/**
 * Matrix bridge manager RPCs. get_server_matrix_bridges and set_matrix_bridge_sender_mode need
 * MANAGE_SERVER; configure_matrix_bridge also needs the caller to own the bot.
 */
import { supabase } from '@/supabase'

/** docs/run/matrix-bridge.md on the docs site (docs/.vitepress/config.ts: sitemap hostname, cleanUrls). */
export const MATRIX_BRIDGE_GUIDE_URL = 'https://docs.mony.lol/run/matrix-bridge'

export const MATRIX_SENDER_MODES = ['ghost', 'relay'] as const
export type MatrixSenderMode = (typeof MATRIX_SENDER_MODES)[number]

/**
 * One bot/channel binding; room_id is null until the bridge service binds a room. active is
 * bridge_channel_platform() = 'matrix': false once the bot or its install no longer qualifies.
 */
export interface MatrixBridgePair {
  bot_id: string
  bot_display_name: string
  channel_id: string
  channel_name: string
  room_id: string | null
  sender_mode: MatrixSenderMode
  active: boolean
}

export const matrixPairKey = (row: Pick<MatrixBridgePair, 'bot_id' | 'channel_id'>) => `${row.bot_id}:${row.channel_id}`

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
  return nonEmpty(row.bot_id) && nonEmpty(row.bot_display_name) && nonEmpty(row.channel_id) && nonEmpty(row.channel_name)
    && (row.room_id === null || nonEmpty(row.room_id))
    && isMatrixSenderMode(row.sender_mode)
    && typeof row.active === 'boolean'
}

function pairOf(row: MatrixBridgePair): MatrixBridgePair {
  const { bot_id, bot_display_name, channel_id, channel_name, room_id, sender_mode, active } = row
  return { bot_id, bot_display_name, channel_id, channel_name, room_id, sender_mode, active }
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

/** One of the caller's bots installed in the server, as configure_matrix_bridge reads it. */
export interface MatrixBotInstall {
  bot_id: string
  bot_display_name: string
  bot_active: boolean
  install_active: boolean
  read_send: boolean
  /** The install's channel allowlist; null admits every channel the bot can view. */
  allowed_channel_ids: string[] | null
}

/** Why a bot cannot bridge Matrix in the server; the order is the order of configure_matrix_bridge's checks. */
export type MatrixBotBlock = 'bot_inactive' | 'install_inactive' | 'read_send' | 'all_channels' | 'no_channels'

interface InstallRow {
  bot_id?: unknown
  is_active?: unknown
  read_messages?: unknown
  send_messages?: unknown
  allowed_channel_ids?: unknown
  bot?: { id?: unknown; username?: unknown; display_name?: unknown; owner_id?: unknown; is_active?: unknown } | null
}

const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonEmpty)

/**
 * The caller's bots installed in the server. Bots of a Discord bridge the caller manages are left
 * out; configure_matrix_bridge refuses them, and also a bridge-type bot a v1 pairing trusts.
 */
export async function fetchOwnedBotInstalls(serverId: string, ownerId: string): Promise<MatrixBotInstall[]> {
  const { data, error } = await supabase
    .from('bot_server_permissions')
    .select('bot_id, is_active, read_messages, send_messages, allowed_channel_ids, bot:bots!inner(id, username, display_name, owner_id, is_active)')
    .eq('server_id', serverId)
    .eq('bot.owner_id', ownerId)
  if (error) throw error
  if (!Array.isArray(data)) throw new InvalidMatrixBridgeResponse()
  const installs: MatrixBotInstall[] = []
  for (const row of data as InstallRow[]) {
    const bot = row.bot
    if (!bot || bot.owner_id !== ownerId || !nonEmpty(row.bot_id) || bot.id !== row.bot_id) continue
    if (row.allowed_channel_ids !== null && !isIdList(row.allowed_channel_ids)) throw new InvalidMatrixBridgeResponse()
    const name = nonEmpty(bot.display_name) ? bot.display_name : nonEmpty(bot.username) ? bot.username : row.bot_id
    installs.push({
      bot_id: row.bot_id,
      bot_display_name: name,
      bot_active: bot.is_active === true,
      install_active: row.is_active === true,
      read_send: row.read_messages === true && row.send_messages === true,
      allowed_channel_ids: row.allowed_channel_ids === null ? null : [...(row.allowed_channel_ids as string[])],
    })
  }
  if (!installs.length) return installs
  const bridges = await supabase
    .from('discord_bridges')
    .select('bot_id')
    .in('bot_id', installs.map(install => install.bot_id))
  if (bridges.error) throw bridges.error
  const discordBots = new Set(((bridges.data ?? []) as { bot_id?: unknown }[]).map(row => row.bot_id))
  return installs
    .filter(install => !discordBots.has(install.bot_id))
    .sort((a, b) => a.bot_display_name.localeCompare(b.bot_display_name) || a.bot_id.localeCompare(b.bot_id))
}

/** Why `install` cannot bridge Matrix in a server with these text channels; null when it can. */
export function matrixBotBlock(install: MatrixBotInstall, textChannelIds: readonly string[]): MatrixBotBlock | null {
  if (!install.bot_active) return 'bot_inactive'
  if (!install.install_active) return 'install_inactive'
  if (!install.read_send) return 'read_send'
  if (install.allowed_channel_ids === null) return 'all_channels'
  const allowed = new Set(install.allowed_channel_ids)
  return textChannelIds.some(id => allowed.has(id)) ? null : 'no_channels'
}

/** The locale key under matrixBridge.errors for a failed configure or unconfigure. */
export function matrixBridgeErrorKey(error: unknown): 'discordBot' | 'allowlist' | 'install' | 'permission' | 'save' {
  const message = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : ''
  if (message.includes('Discord bridge bot')) return 'discordBot'
  if (message.includes('install allowlist')) return 'allowlist'
  if (message.includes('install required') || message.includes('Active bot required')) return 'install'
  if ((error as { code?: unknown } | null)?.code === '42501') return 'permission'
  return 'save'
}
