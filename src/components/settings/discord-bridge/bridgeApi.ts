/**
 * Reads and RPCs behind Server Settings → Discord Bridge. Tables are readable by members
 * holding MANAGE_SERVER; every write goes through a discord_bridge_* RPC.
 */
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
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

export const IMPORT_MODE_KEY = 'bridge_history_import'
export const IMPORT_MAX_RUNNING_KEY = 'bridge_import_max_running'
export const IMPORT_RATE_KEY = 'bridge_import_messages_per_minute'
export const MIRROR_SERVER_LIMIT_KEY = 'bridge_mirror_server_limit_mb'
// Defaults of 20261112700001 and 20261112800001.
export const DEFAULT_IMPORT_MAX_RUNNING = 1
export const DEFAULT_IMPORT_RATE = 600
export const DEFAULT_MIRROR_SERVER_LIMIT_MB = 5120

export type BridgeInstanceConfigKey =
  | typeof HOSTING_ENABLED_KEY
  | typeof HOSTING_LIMIT_KEY
  | typeof INSTANCE_BOT_ENABLED_KEY
  | typeof INSTANCE_BOT_PRESENCE_KEY
  | typeof INSTANCE_BOT_LIMIT_KEY
  | typeof IMPORT_MODE_KEY
  | typeof IMPORT_MAX_RUNNING_KEY
  | typeof IMPORT_RATE_KEY
  | typeof MIRROR_SERVER_LIMIT_KEY

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
// History import
// ---------------------------------------------------------------------------

export type ImportState = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'
export type ImportPhase = 'messages' | 'threads' | 'replies'

export interface ImportJob {
  id: string
  harmony_channel_id: string
  discord_channel_id: string
  state: ImportState
  phase: ImportPhase
  cancel_requested: boolean
  start_discord_message_id: string | null
  start_at: string | null
  reached_discord_message_id: string | null
  reached_at: string | null
  channel_created_at: string | null
  threads_total: number | null
  threads_done: number
  thread_cursor: Record<string, unknown> | null
  imported_count: number
  skipped_count: number
  pins_skipped: number
  /** Messages the bridge left out for their author: left the Discord server, or opted out. */
  authors_skipped: number
  /** Messages a blocking AutoMod rule of the server refused. */
  automod_skipped: number
  error: string | null
  requested_via: 'harmony' | 'discord'
  /** The Discord member who ran the command, for a job started from Discord. */
  requested_by_remote: { id: string; username?: string } | null
  created_at: string
  updated_at: string
  finished_at: string | null
}

const IMPORT_COLUMNS =
  'id, harmony_channel_id, discord_channel_id, state, phase, cancel_requested, start_discord_message_id, start_at, reached_discord_message_id, reached_at, channel_created_at, threads_total, threads_done, thread_cursor, imported_count, skipped_count, pins_skipped, authors_skipped, automod_skipped, error, requested_via, requested_by_remote, created_at, updated_at, finished_at'

export async function fetchImports(bridgeId: string): Promise<ImportJob[]> {
  const { data, error } = await supabase
    .from('discord_bridge_imports')
    .select(IMPORT_COLUMNS)
    .eq('bridge_id', bridgeId)
    .order('created_at', { ascending: true })
  raise(error)
  return (data as ImportJob[] | null) ?? []
}

/** harmonyChannelIds null queues every importable pair; an empty list queues nothing. */
export async function startImports(bridgeId: string, harmonyChannelIds: string[] | null): Promise<ImportJob[]> {
  const { data, error } = await supabase.rpc('discord_bridge_import_start', {
    p_bridge_id: bridgeId,
    p_harmony_channel_ids: harmonyChannelIds,
  })
  raise(error)
  return (data as ImportJob[] | null) ?? []
}

/** importId null cancels every job of the bridge. */
export async function cancelImports(bridgeId: string, importId: string | null): Promise<ImportJob[]> {
  const { data, error } = await supabase.rpc('discord_bridge_import_cancel', {
    p_bridge_id: bridgeId,
    p_import_id: importId,
  })
  raise(error)
  return (data as ImportJob[] | null) ?? []
}

/**
 * bridge_attachment_mode, a public instance_config key (public_instance_config_keys()), so any
 * signed-in manager reads it. Null when unset or unreadable.
 */
export async function fetchBridgeAttachmentMode(): Promise<'link' | 'refresh' | 'mirror' | null> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_value')
    .eq('config_key', 'bridge_attachment_mode')
    .maybeSingle()
  if (error) {
    debug.error('bridge_attachment_mode read failed:', error)
    return null
  }
  const value = (data as { config_value?: unknown } | null)?.config_value
  return value === 'link' || value === 'refresh' || value === 'mirror' ? value : null
}

export type HistoryImportMode = 'off' | 'self_run'

/**
 * bridge_history_import, a public instance_config key. 'off' when unset or unreadable: the
 * server refuses an import the instance has not switched on.
 */
export async function fetchHistoryImportMode(): Promise<HistoryImportMode> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_value')
    .eq('config_key', 'bridge_history_import')
    .maybeSingle()
  if (error) {
    debug.error('bridge_history_import read failed:', error)
    return 'off'
  }
  return (data as { config_value?: unknown } | null)?.config_value === 'self_run' ? 'self_run' : 'off'
}

// ---------------------------------------------------------------------------
// Bridge privacy
// ---------------------------------------------------------------------------

/** bridge_remote_optouts.platform of a Discord bridge. */
const DISCORD_PLATFORM = 'discord'

export interface BridgeOptout {
  remote_user_id: string
  /** self: the Discord member's own /bridge-privacy; manager, admin: removed here. */
  source: 'self' | 'manager' | 'admin'
  created_at: string
}

export interface EraseResult {
  erased: number
  /** More rows remain: call again. */
  more: boolean
}

export async function fetchBridgeOptouts(serverId: string): Promise<BridgeOptout[]> {
  const { data, error } = await supabase
    .from('bridge_remote_optouts')
    .select('remote_user_id, source, created_at')
    .eq('server_id', serverId)
    .eq('platform', DISCORD_PLATFORM)
    .order('created_at', { ascending: false })
  raise(error)
  return (data as BridgeOptout[] | null) ?? []
}

/** Runs one batch RPC until nothing is left; `onProgress` gets the running total. */
async function eraseAll(
  call: () => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>,
  onProgress?: (total: number) => void,
): Promise<number> {
  let total = 0
  // 200 rows a batch: 5000 batches is a million rows.
  for (let i = 0; i < 5000; i++) {
    const { data, error } = await call()
    raise(error)
    const result = (data ?? {}) as Partial<EraseResult>
    total += Number(result.erased) || 0
    onProgress?.(total)
    if (result.more !== true) break
  }
  return total
}

/** Opts a Discord user out of the server's bridge and deletes their relayed and imported messages. */
export function removeBridgedUser(serverId: string, discordUserId: string, onProgress?: (total: number) => void): Promise<number> {
  return eraseAll(() => supabase.rpc('bridge_privacy_remove_remote_user', {
    p_server_id: serverId,
    p_platform: DISCORD_PLATFORM,
    p_remote_user_id: discordUserId,
  }), onProgress)
}

/** Lifts a removal made here. False for a member's own opt-out, which only they lift. */
export async function restoreBridgedUser(serverId: string, discordUserId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('bridge_privacy_restore_remote_user', {
    p_server_id: serverId,
    p_platform: DISCORD_PLATFORM,
    p_remote_user_id: discordUserId,
  })
  raise(error)
  return data === true
}

/** Deletes every message, reaction and AutoMod event the server's bridge brought from Discord. */
export function purgeBridgedMessages(serverId: string, onProgress?: (total: number) => void): Promise<number> {
  return eraseAll(() => supabase.rpc('bridge_privacy_purge_server', {
    p_server_id: serverId,
    p_platform: DISCORD_PLATFORM,
  }), onProgress)
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
export async function saveBridgeInstanceConfig(key: BridgeInstanceConfigKey, value: boolean | number | string): Promise<void> {
  const { data, error } = await supabase.rpc('batch_set_instance_config', { p_keys: [key], p_values: [value] })
  if (error) throw new Error(error.message)
  if (data === false) throw new Error(`batch_set_instance_config refused ${key}`)
}

export interface ImportAdminConfig {
  mode: HistoryImportMode
  /** 0 is no limit, for each of the three. */
  maxRunning: number
  messagesPerMinute: number
  mirrorServerLimitMb: number
}

export async function fetchImportAdminConfig(): Promise<ImportAdminConfig> {
  const keys = [IMPORT_MODE_KEY, IMPORT_MAX_RUNNING_KEY, IMPORT_RATE_KEY, MIRROR_SERVER_LIMIT_KEY]
  const { data, error } = await supabase.from('instance_config').select('config_key, config_value').in('config_key', keys)
  if (error) throw new Error(error.message)
  const rows = (data as { config_key: string; config_value: unknown }[] | null) ?? []
  const count = (key: string, fallback: number) => {
    const raw = rows.find((r) => r.config_key === key)?.config_value
    const value = Number(raw)
    return raw != null && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
  }
  return {
    mode: rows.find((r) => r.config_key === IMPORT_MODE_KEY)?.config_value === 'self_run' ? 'self_run' : 'off',
    maxRunning: count(IMPORT_MAX_RUNNING_KEY, DEFAULT_IMPORT_MAX_RUNNING),
    messagesPerMinute: count(IMPORT_RATE_KEY, DEFAULT_IMPORT_RATE),
    mirrorServerLimitMb: count(MIRROR_SERVER_LIMIT_KEY, DEFAULT_MIRROR_SERVER_LIMIT_MB),
  }
}

/** bridge_import_status() and bridge_mirror_status(), for instance admins. Null fields were unreadable. */
export interface ImportTotals {
  running: number
  queued: number
  imported: number
  /** Bytes of Discord files in storage; null before 20261112800001 or when unreadable. */
  storedBytes: number | null
}

export async function fetchImportTotals(): Promise<ImportTotals | null> {
  const [imports, mirror] = await Promise.all([supabase.rpc('bridge_import_status'), supabase.rpc('bridge_mirror_status')])
  if (imports.error || !imports.data) return null
  const totals = imports.data as { running?: unknown; queued?: unknown; imported?: unknown }
  const stored = Number((mirror.data as { stored_bytes?: unknown } | null)?.stored_bytes)
  return {
    running: Number(totals.running) || 0,
    queued: Number(totals.queued) || 0,
    imported: Number(totals.imported) || 0,
    storedBytes: !mirror.error && Number.isFinite(stored) ? stored : null,
  }
}

/** Deletes everything any bridge brought from Discord, on every server. Instance admins only. */
export function purgeInstanceBridgedMessages(onProgress?: (total: number) => void): Promise<number> {
  return eraseAll(() => supabase.rpc('bridge_privacy_purge_instance', { p_platform: DISCORD_PLATFORM }), onProgress)
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
