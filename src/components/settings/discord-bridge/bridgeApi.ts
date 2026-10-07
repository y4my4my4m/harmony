/**
 * Reads and RPCs behind Server Settings → Discord Bridge. Tables are readable by members
 * holding MANAGE_SERVER; every write goes through a discord_bridge_* RPC.
 */
import { supabase } from '@/supabase'
import type {
  BridgeMode,
  BridgePairRow,
  BridgeSettings,
  DiscordBridgeRow,
  HarmonyChannelOption,
  PairDirection,
} from '@/utils/discordBridgeSetup'

export const HOSTING_ENABLED_KEY = 'discord_bridge_hosting_enabled'
export const HOSTING_LIMIT_KEY = 'discord_bridge_hosting_limit'
export const DEFAULT_HOSTING_LIMIT = 25
export const INSTANCE_BOT_ENABLED_KEY = 'discord_bridge_instance_bot_enabled'
export const INSTANCE_BOT_PRESENCE_KEY = 'discord_bridge_instance_presence'
export const INSTANCE_BOT_LIMIT_KEY = 'discord_bridge_instance_bot_limit'
/** Discord's server cap for an unverified bot. */
export const DEFAULT_INSTANCE_BOT_LIMIT = 100

export type BridgeInstanceConfigKey =
  | typeof HOSTING_ENABLED_KEY
  | typeof HOSTING_LIMIT_KEY
  | typeof INSTANCE_BOT_ENABLED_KEY
  | typeof INSTANCE_BOT_PRESENCE_KEY
  | typeof INSTANCE_BOT_LIMIT_KEY

const BRIDGE_COLUMNS =
  'id, server_id, bot_id, mode, discord_guild_id, discord_guild_name, discord_application_id, discord_bot_name, settings, snapshot, status, bridge_version, last_seen_at, created_at, updated_at'
const PAIR_COLUMNS = 'id, bridge_id, harmony_channel_id, discord_channel_id, discord_channel_name, direction, created_at'

/** PostgREST and Postgres codes for a relation or function the instance's schema lacks. */
const MISSING_CODES = new Set(['42P01', '42883', 'PGRST202', 'PGRST205'])

export class BridgeUnavailableError extends Error {
  constructor() {
    super('discord bridge v2 schema is absent on this instance')
    this.name = 'BridgeUnavailableError'
  }
}

function raise(error: { code?: string; message?: string } | null): void {
  if (!error) return
  if (error.code && MISSING_CODES.has(error.code)) throw new BridgeUnavailableError()
  throw Object.assign(new Error(error.message || 'Request failed'), { code: error.code })
}

export async function fetchBridge(serverId: string): Promise<DiscordBridgeRow | null> {
  const { data, error } = await supabase
    .from('discord_bridges')
    .select(BRIDGE_COLUMNS)
    .eq('server_id', serverId)
    .maybeSingle()
  raise(error)
  return (data as DiscordBridgeRow | null) ?? null
}

export async function fetchBridgePairs(bridgeId: string): Promise<BridgePairRow[]> {
  const { data, error } = await supabase
    .from('discord_bridge_channels')
    .select(PAIR_COLUMNS)
    .eq('bridge_id', bridgeId)
    .order('created_at', { ascending: true })
  raise(error)
  return (data as BridgePairRow[] | null) ?? []
}

interface ChannelRow {
  id: string
  name: string
  type: number
  category: string | null
  order: number | null
}

interface CategoryRow {
  id: string
  name: string
  order: number | null
}

/** Text channels (type 0) in sidebar order, uncategorised first. */
export async function fetchServerTextChannels(serverId: string): Promise<HarmonyChannelOption[]> {
  const [channels, categories] = await Promise.all([
    supabase.from('channels').select('id, name, type, category, order').eq('server_id', serverId),
    supabase.from('channel_categories').select('id, name, order').eq('server_id', serverId),
  ])
  if (channels.error) throw new Error(channels.error.message)
  const categoryRows = (categories.data as CategoryRow[] | null) ?? []
  const categoryOrder = new Map(categoryRows.map((c) => [c.id, c.order ?? 0]))
  const categoryName = new Map(categoryRows.map((c) => [c.id, c.name]))
  return ((channels.data as ChannelRow[] | null) ?? [])
    .filter((c) => c.type === 0)
    .sort((a, b) => {
      const ca = a.category ? (categoryOrder.get(a.category) ?? 0) + 1 : 0
      const cb = b.category ? (categoryOrder.get(b.category) ?? 0) + 1 : 0
      return ca - cb || (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name)
    })
    .map((c) => ({ id: c.id, name: c.name, categoryName: c.category ? (categoryName.get(c.category) ?? null) : null }))
}

function configBool(value: unknown): boolean {
  return value === true || value === 'true'
}

/** False when the key is unset or hidden from this caller by instance_config RLS. */
export async function fetchHostingEnabled(): Promise<boolean> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_value')
    .eq('config_key', HOSTING_ENABLED_KEY)
    .maybeSingle()
  if (error) return false
  return configBool((data as { config_value?: unknown } | null)?.config_value)
}

/** discord_bridge_instance_bot_enabled, a public instance_config key; false when unset. */
export async function fetchInstanceBotEnabled(): Promise<boolean> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_value')
    .eq('config_key', INSTANCE_BOT_ENABLED_KEY)
    .maybeSingle()
  if (error) return false
  return configBool((data as { config_value?: unknown } | null)?.config_value)
}

export interface InstanceLink {
  bridgeId: string
  state: string
}

/**
 * discord_bridge_instance_link: creates the server's instance bridge on first use and returns a
 * one-time state for GET /bridge/v2/discord/authorize, valid 15 minutes.
 */
export async function createInstanceLink(serverId: string): Promise<InstanceLink> {
  const { data, error } = await supabase.rpc('discord_bridge_instance_link', { p_server_id: serverId })
  raise(error)
  const row = (data ?? {}) as { bridge_id?: string; state?: string }
  if (!row.bridge_id || !row.state) throw new Error('discord_bridge_instance_link returned no state')
  return { bridgeId: row.bridge_id, state: row.state }
}

export interface LegacyPairing {
  pairing_code: string
  created_at: string | null
}

export async function fetchLegacyPairing(serverId: string): Promise<LegacyPairing | null> {
  const { data, error } = await supabase
    .from('discord_bridge_pairings')
    .select('pairing_code, created_at')
    .eq('server_id', serverId)
    .maybeSingle()
  if (error) return null
  return (data as LegacyPairing | null) ?? null
}

export async function regenerateLegacyPairing(serverId: string): Promise<string> {
  const { data, error } = await supabase.rpc('regenerate_discord_bridge_pairing', { p_server_id: serverId })
  raise(error)
  return data as string
}

export async function createBridge(serverId: string, mode: BridgeMode): Promise<string> {
  const { data, error } = await supabase.rpc('discord_bridge_create', { p_server_id: serverId, p_mode: mode })
  raise(error)
  return data as string
}

export interface IssuedSetupCode {
  code: string
  issuedAt: number
}

/**
 * Last code issued per bridge in this page session. Issuing invalidates older codes, so a
 * remounted step reuses the code whose command the admin may already have copied.
 */
const issuedCodes = new Map<string, IssuedSetupCode>()

export function lastIssuedSetupCode(bridgeId: string): IssuedSetupCode | null {
  return issuedCodes.get(bridgeId) ?? null
}

export function forgetIssuedSetupCodes(): void {
  issuedCodes.clear()
}

export async function createSetupCode(bridgeId: string): Promise<IssuedSetupCode> {
  const { data, error } = await supabase.rpc('discord_bridge_setup_code', { p_bridge_id: bridgeId })
  raise(error)
  const issued = { code: data as string, issuedAt: Date.now() }
  issuedCodes.set(bridgeId, issued)
  return issued
}

export async function setHostedToken(bridgeId: string, token: string): Promise<void> {
  const { error } = await supabase.rpc('discord_bridge_set_hosted_token', {
    p_bridge_id: bridgeId,
    p_discord_token: token,
  })
  raise(error)
}

export async function setGuild(bridgeId: string, guildId: string): Promise<void> {
  const { error } = await supabase.rpc('discord_bridge_set_guild', { p_bridge_id: bridgeId, p_guild_id: guildId })
  raise(error)
}

export async function pairChannels(
  bridgeId: string,
  harmonyChannelId: string,
  discordChannelId: string,
  direction: PairDirection,
): Promise<void> {
  const { error } = await supabase.rpc('discord_bridge_pair', {
    p_bridge_id: bridgeId,
    p_harmony_channel_id: harmonyChannelId,
    p_discord_channel_id: discordChannelId,
    p_direction: direction,
  })
  raise(error)
}

export async function unpairChannel(bridgeId: string, harmonyChannelId: string): Promise<void> {
  const { error } = await supabase.rpc('discord_bridge_unpair', {
    p_bridge_id: bridgeId,
    p_harmony_channel_id: harmonyChannelId,
  })
  raise(error)
}

/** Sends every whitelisted key, so merge and replace semantics on the server agree. */
export async function updateSettings(bridgeId: string, settings: BridgeSettings): Promise<void> {
  const { error } = await supabase.rpc('discord_bridge_update_settings', {
    p_bridge_id: bridgeId,
    p_settings: settings,
  })
  raise(error)
}

export async function deleteBridge(bridgeId: string): Promise<void> {
  const { error } = await supabase.rpc('discord_bridge_delete', { p_bridge_id: bridgeId })
  raise(error)
}

export interface BridgeOwnerServer {
  serverId: string
  serverName: string | null
}

/** Server whose bridge acts as this bot; null for a bot no v2 bridge uses. */
export async function fetchBridgeForBot(botId: string): Promise<BridgeOwnerServer | null> {
  const { data, error } = await supabase
    .from('discord_bridges')
    .select('server_id, servers(name)')
    .eq('bot_id', botId)
    .maybeSingle()
  if (error || !data) return null
  const row = data as { server_id: string; servers?: { name?: string | null } | { name?: string | null }[] | null }
  const server = Array.isArray(row.servers) ? row.servers[0] : row.servers
  return { serverId: row.server_id, serverName: server?.name ?? null }
}

// ---------------------------------------------------------------------------
// Instance admin
// ---------------------------------------------------------------------------

export interface HostingConfig {
  enabled: boolean
  limit: number
}

export async function fetchHostingConfig(): Promise<HostingConfig> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_key, config_value')
    .in('config_key', [HOSTING_ENABLED_KEY, HOSTING_LIMIT_KEY])
  if (error) throw new Error(error.message)
  const rows = (data as { config_key: string; config_value: unknown }[] | null) ?? []
  const value = (key: string) => rows.find((r) => r.config_key === key)?.config_value
  const limit = Number(value(HOSTING_LIMIT_KEY))
  return {
    enabled: configBool(value(HOSTING_ENABLED_KEY)),
    limit: Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_HOSTING_LIMIT,
  }
}

/** Writes one bridge instance_config key; batch_set_instance_config requires an instance admin. */
export async function saveBridgeInstanceConfig(key: BridgeInstanceConfigKey, value: boolean | number): Promise<void> {
  const { data, error } = await supabase.rpc('batch_set_instance_config', { p_keys: [key], p_values: [value] })
  if (error) throw new Error(error.message)
  if (data === false) throw new Error(`batch_set_instance_config refused ${key}`)
}

/** discord_bridge_instance_bot_status(): never carries a secret. */
export interface InstanceBotStatus {
  enabled: boolean
  configured: boolean
  applicationId: string | null
  hasClientSecret: boolean
  hasBotToken: boolean
  botUserName: string | null
  linkedCount: number
  limit: number
  presence: boolean
}

function toInstanceBotStatus(raw: unknown): InstanceBotStatus {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const limit = Number(row.limit)
  return {
    enabled: row.enabled === true,
    configured: row.configured === true,
    applicationId: typeof row.application_id === 'string' ? row.application_id : null,
    hasClientSecret: row.has_client_secret === true,
    hasBotToken: row.has_bot_token === true,
    botUserName: typeof row.bot_user_name === 'string' ? row.bot_user_name : null,
    linkedCount: Number.isFinite(Number(row.linked_count)) ? Number(row.linked_count) : 0,
    limit: Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_INSTANCE_BOT_LIMIT,
    presence: row.presence === true,
  }
}

export async function fetchInstanceBotStatus(): Promise<InstanceBotStatus> {
  const { data, error } = await supabase.rpc('discord_bridge_instance_bot_status')
  raise(error)
  return toInstanceBotStatus(data)
}

/** Empty strings keep the stored value; secrets go to Vault and never come back. */
export async function saveInstanceBotCredentials(input: {
  applicationId: string
  clientSecret: string
  botToken: string
}): Promise<InstanceBotStatus> {
  const { data, error } = await supabase.rpc('discord_bridge_instance_bot_set', {
    p_application_id: input.applicationId.trim() || null,
    p_client_secret: input.clientSecret.trim() || null,
    p_bot_token: input.botToken.trim() || null,
  })
  raise(error)
  return toInstanceBotStatus(data)
}

/** Deletes the stored application and secrets and turns the instance bot off. */
export async function clearInstanceBot(): Promise<void> {
  const { error } = await supabase.rpc('discord_bridge_instance_bot_clear')
  raise(error)
}
