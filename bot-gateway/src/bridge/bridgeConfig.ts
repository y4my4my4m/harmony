import type { Request } from 'express'
import { supabase, config } from '../config/supabase.js'
import { botCanSeeChannel, loadEveryoneLayers, loadInstall } from '../auth/botPermissions.js'

export const SNOWFLAKE = /^[0-9]{1,20}$/
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Characters a typed setup code may carry between its groups: whitespace, '-', U+2010-U+2015, U+2212.
const CODE_SEPARATORS = /[\s\-\u2010-\u2015\u2212]/g

/**
 * Canonical 'HB-XXXX-XXXX-XXXX' form of a typed setup code: case, separators and the HB prefix
 * are optional. Null when 12 characters of [A-Z0-9] do not remain. Mirrors
 * discord_bridge_normalize_code().
 */
export function normalizeSetupCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const compact = raw.replace(CODE_SEPARATORS, '').toUpperCase()
  const match = /^(?:HB)?([A-Z0-9]{12})$/.exec(compact)
  if (!match) return null
  const body = match[1]
  return `HB-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`
}
export const DIRECTIONS = ['both', 'to_harmony', 'to_discord'] as const
export type Direction = (typeof DIRECTIONS)[number]

/** discord_bridges.mode. */
export type BridgeMode = 'self' | 'hosted' | 'instance'

// channels.type: 0 text, 1 voice, 2 category.
const CATEGORY_TYPE = 2

export interface BridgeRow {
  id: string
  server_id: string
  bot_id: string | null
  mode: BridgeMode
  discord_guild_id: string | null
  settings: Record<string, unknown>
  updated_at: string
}

export const BRIDGE_COLUMNS = 'id, server_id, bot_id, mode, discord_guild_id, settings, updated_at'

export interface BridgePair {
  harmony_channel_id: string
  harmony_channel_name: string | null
  discord_channel_id: string
  discord_channel_name: string | null
  direction: Direction
}

export interface HarmonyChannel {
  id: string
  name: string
  type: number
  category: string | null
  category_id: string | null
  // Messages are end-to-end encrypted (channel_messages_encrypted); the bridge cannot relay them.
  encrypted: boolean
}

/** GET /bridge/v2/config and the BRIDGE_CONFIG_UPDATE payload. */
export interface BridgeConfig {
  bridge_id: string
  server_id: string
  mode: BridgeMode
  discord_guild_id: string | null
  settings: Record<string, unknown>
  updated_at: string
  // Instance public base URL, as POST /redeem returns it; null when unknown (see configuredBaseUrl).
  base_url: string | null
  pairs: BridgePair[]
  harmony_channels: HarmonyChannel[]
}

/** The bridge the bot drives; null when it drives none; 'error' when the lookup failed. */
export async function loadBridgeForBot(botId: string): Promise<BridgeRow | null | 'error'> {
  const { data, error } = await supabase
    .from('discord_bridges')
    .select(BRIDGE_COLUMNS)
    .eq('bot_id', botId)
    .maybeSingle()
  if (error) {
    console.error(`discord_bridges lookup for bot ${botId} failed:`, error.message)
    return 'error'
  }
  return (data as BridgeRow | null) ?? null
}

/**
 * Pairs with their Harmony names, and the channels the bridge bot sees (botCanSeeChannel, the
 * same visibility its message events follow), categories excluded, each with its encryption
 * state. Null when a lookup fails: an unknown encryption state is not reported as plaintext.
 */
export async function buildBridgeConfig(bridge: BridgeRow, baseUrl: string | null): Promise<BridgeConfig | null> {
  const [pairsResult, channelsResult, categoriesResult, encryptedResult] = await Promise.all([
    supabase
      .from('discord_bridge_channels')
      .select('harmony_channel_id, discord_channel_id, discord_channel_name, direction')
      .eq('bridge_id', bridge.id),
    supabase.from('channels').select('*').eq('server_id', bridge.server_id),
    supabase.from('channel_categories').select('id, name').eq('server_id', bridge.server_id),
    supabase.rpc('discord_bridge_encrypted_channel_ids', { p_bridge_id: bridge.id }),
  ])
  for (const [what, result] of [
    ['discord_bridge_channels', pairsResult],
    ['channels', channelsResult],
    ['channel_categories', categoriesResult],
    ['discord_bridge_encrypted_channel_ids', encryptedResult],
  ] as const) {
    if (result.error || !Array.isArray(result.data)) {
      console.error(`bridge ${bridge.id} config: ${what} lookup failed:`, result.error?.message)
      return null
    }
  }
  // SETOF uuid arrives as bare strings.
  const encrypted = new Set((encryptedResult.data as unknown[]).map((id) => String(id).toLowerCase()))

  type ChannelRow = { id: string; name: string; type: number | null; category: string | null; order?: number | null }
  const channels = channelsResult.data as ChannelRow[]
  const channelById = new Map(channels.map((c) => [c.id, c]))
  const categoryName = new Map(
    (categoriesResult.data as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
  )

  const candidates = channels.filter((c) => c.type !== CATEGORY_TYPE)
  const install = bridge.bot_id ? await loadInstall(bridge.bot_id, bridge.server_id) : null
  const layers = install
    ? await loadEveryoneLayers(candidates.map((c) => ({ id: c.id, server_id: bridge.server_id })))
    : new Map()

  const harmonyChannels: HarmonyChannel[] = candidates
    .filter((c) => {
      const layer = layers.get(c.id)
      return install !== null && layer !== undefined && botCanSeeChannel(install, layer, c.id)
    })
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type ?? 0,
      category: c.category ? categoryName.get(c.category) ?? null : null,
      category_id: c.category ?? null,
      encrypted: encrypted.has(c.id.toLowerCase()),
    }))

  const pairs = (pairsResult.data as Array<Omit<BridgePair, 'harmony_channel_name'>>).map((p) => ({
    harmony_channel_id: p.harmony_channel_id,
    harmony_channel_name: channelById.get(p.harmony_channel_id)?.name ?? null,
    discord_channel_id: p.discord_channel_id,
    discord_channel_name: p.discord_channel_name ?? null,
    direction: p.direction,
  }))

  return {
    bridge_id: bridge.id,
    server_id: bridge.server_id,
    mode: bridge.mode,
    discord_guild_id: bridge.discord_guild_id,
    settings: bridge.settings,
    updated_at: bridge.updated_at,
    base_url: baseUrl,
    pairs,
    harmony_channels: harmonyChannels,
  }
}

/** INSTANCE_DOMAIN, else PUBLIC_URL, as an origin with a scheme (https when none); null when neither is set. */
export function configuredBaseUrl(): string | null {
  const configured = config.bridge?.instanceDomain || config.bridge?.publicUrl || ''
  if (!configured) return null
  return (/^https?:\/\//i.test(configured) ? configured : `https://${configured}`).replace(/\/+$/, '')
}

/**
 * Instance URLs handed to a bridge: configuredBaseUrl(), with the gateway at /bot-gateway behind
 * the instance's reverse proxy. Without one, the origin the request reached, which is the
 * gateway itself.
 */
export function bridgeUrls(req: Request): { base_url: string; api_url: string; gateway_url: string } {
  const base = configuredBaseUrl()
  if (base) {
    const ws = base.replace(/^http/i, 'ws')
    return { base_url: base, api_url: `${base}/bot-gateway`, gateway_url: `${ws}/bot-gateway/gateway` }
  }
  const origin = `${req.protocol}://${req.get('host')}`
  return { base_url: origin, api_url: origin, gateway_url: `${origin.replace(/^http/i, 'ws')}/gateway` }
}

// Status report caps. The database refuses a snapshot over 2 MiB; these keep a report well under.
const MAX_GUILDS = 100
const MAX_CHANNELS_PER_GUILD = 500
const MAX_PROBLEMS = 50
const MAX_PROBLEM_PARAMS = 10
const PROBLEM_CODE = /^[a-z][a-z0-9_]{0,63}$/
const PARAM_KEY = /^[a-z][a-z0-9_]{0,31}$/

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null
}

function snowflake(value: unknown): string | null {
  return typeof value === 'string' && SNOWFLAKE.test(value) ? value : null
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export interface StatusReport {
  version: string | null
  status: Record<string, unknown>
  snapshot: { guilds: unknown[] }
}

/**
 * POST /bridge/v2/status body, reduced to the documented fields with bounded sizes. Unknown
 * fields are dropped; a guild or channel without a Discord id is dropped. Null when the body is
 * not an object.
 */
export function sanitizeStatusReport(body: unknown): StatusReport | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const input = body as Record<string, unknown>

  const discordIn = obj(input.discord)
  const botUserIn = discordIn.bot_user && typeof discordIn.bot_user === 'object' ? obj(discordIn.bot_user) : null
  const intentsIn = obj(discordIn.intents)
  const discord = {
    connected: discordIn.connected === true,
    application_id: snowflake(discordIn.application_id),
    bot_user: botUserIn
      ? { id: snowflake(botUserIn.id), name: str(botUserIn.name, 100), avatar: str(botUserIn.avatar, 512) }
      : null,
    intents: {
      message_content: intentsIn.message_content === true,
      members: intentsIn.members === true,
      presence: intentsIn.presence === true,
    },
  }

  const guilds = (Array.isArray(input.guilds) ? input.guilds : [])
    .map(obj)
    .filter((g) => snowflake(g.id) !== null)
    .slice(0, MAX_GUILDS)
    .map((g) => ({
      id: g.id as string,
      name: str(g.name, 100),
      icon: str(g.icon, 512),
      channels: (Array.isArray(g.channels) ? g.channels : [])
        .map(obj)
        .filter((c) => snowflake(c.id) !== null)
        .slice(0, MAX_CHANNELS_PER_GUILD)
        .map((c) => ({
          id: c.id as string,
          name: str(c.name, 100),
          type: int(c.type),
          parent_id: snowflake(c.parent_id),
          position: int(c.position),
          can_view: c.can_view === true,
          can_send: c.can_send === true,
          can_manage_webhooks: c.can_manage_webhooks === true,
        })),
    }))

  const problems = (Array.isArray(input.problems) ? input.problems : [])
    .map(obj)
    .filter((p) => typeof p.code === 'string' && PROBLEM_CODE.test(p.code))
    .slice(0, MAX_PROBLEMS)
    .map((p) => {
      const params: Record<string, string | number | boolean> = {}
      for (const [key, value] of Object.entries(obj(p.params)).slice(0, MAX_PROBLEM_PARAMS)) {
        if (!PARAM_KEY.test(key)) continue
        if (typeof value === 'string') params[key] = value.slice(0, 200)
        else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) params[key] = value
      }
      return { code: p.code as string, params }
    })

  const version = str(input.version, 64)
  return {
    version,
    status: {
      version,
      discord,
      harmony: { connected: obj(input.harmony).connected === true },
      problems,
    },
    snapshot: { guilds },
  }
}
