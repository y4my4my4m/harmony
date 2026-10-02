import { buildBridgeGatewayUrls } from '@/utils/discordBridgeSetup'

/** Every token is this prefix followed by 64 hex characters. */
export const BOT_TOKEN_PREFIX = 'harmony_bot_'

export const BOT_API_DOCS_URL = 'https://github.com/y4my4my4m/harmony/blob/master/docs/bot-api.md'

/** Name colour of bot authors in chat. */
export const BOT_NAME_COLOR = '#0EA5E9'

export const BOT_USERNAME_MIN = 3
export const BOT_USERNAME_MAX = 32

export type BotUsernameError = 'tooShort' | 'tooLong' | 'invalidChars'

/** Mirrors bots.valid_username, narrowed to lowercase. */
export function botUsernameError(username: string): BotUsernameError | null {
  if (username.length < BOT_USERNAME_MIN) return 'tooShort'
  if (username.length > BOT_USERNAME_MAX) return 'tooLong'
  if (!/^[a-z0-9_-]+$/.test(username)) return 'invalidChars'
  return null
}

/**
 * Display form of bot_tokens.token_prefix, which holds the last 4 characters
 * of the token. Rows issued before migration 20260930000001 hold 'harmony_',
 * which identifies nothing; those return null.
 */
export function formatTokenHint(storedHint: string | null | undefined): string | null {
  if (!storedHint || !/^[0-9a-f]{4}$/.test(storedHint)) return null
  return `${BOT_TOKEN_PREFIX}…${storedHint}`
}

/**
 * Three default heartbeat intervals (30 s each). The gateway writes 'offline'
 * on socket close; a gateway process that exits without closing leaves
 * 'online' behind, so the heartbeat age decides.
 */
export const BOT_PRESENCE_STALE_MS = 90_000

export interface BotPresenceRow {
  status?: string | null
  last_heartbeat_at?: string | null
}

export function isBotOnline(presence: BotPresenceRow | null | undefined, now = Date.now()): boolean {
  return botMemberStatus(presence, now) === 'online'
}

export type BotMemberStatus = 'online' | 'away' | 'busy' | 'offline'

/** bot_presence.status in member-list terms: idle is away, dnd is busy. A stale heartbeat is offline. */
export function botMemberStatus(presence: BotPresenceRow | null | undefined, now = Date.now()): BotMemberStatus {
  if (!presence?.last_heartbeat_at) return 'offline'
  const heartbeat = Date.parse(presence.last_heartbeat_at)
  if (!Number.isFinite(heartbeat) || now - heartbeat > BOT_PRESENCE_STALE_MS) return 'offline'
  switch (presence.status) {
    case 'online': return 'online'
    case 'idle': return 'away'
    case 'dnd': return 'busy'
    default: return 'offline'
  }
}

/**
 * bot_server_permissions columns the gateway checks: BotRestAPI.ts route guards
 * and EventDispatcher.ts (read_messages gates event delivery). The table's
 * other flags (embed_links, attach_files, mention_everyone, kick_members,
 * ban_members) have no reader.
 */
export const ENFORCED_BOT_PERMISSIONS = [
  'read_messages',
  'send_messages',
  'add_reactions',
  'manage_messages',
  'manage_channels',
] as const

export type EnforcedBotPermission = (typeof ENFORCED_BOT_PERMISSIONS)[number]

export const REQUIRED_BOT_PERMISSIONS: ReadonlySet<EnforcedBotPermission> = new Set([
  'read_messages',
  'send_messages',
])

/** Bridges create channels for /bridge clone-server, so they start with manage_channels. */
export function defaultBotPermissions(botType?: string | null): Record<EnforcedBotPermission, boolean> {
  return {
    read_messages: true,
    send_messages: true,
    add_reactions: true,
    manage_messages: false,
    manage_channels: botType === 'bridge',
  }
}

/** Reads the enforced flags off a bot_server_permissions row; required flags are forced on. */
export function enforcedPermissionsFrom(
  row: Partial<Record<EnforcedBotPermission, unknown>>,
): Record<EnforcedBotPermission, boolean> {
  const out = {} as Record<EnforcedBotPermission, boolean>
  for (const key of ENFORCED_BOT_PERMISSIONS) {
    out[key] = REQUIRED_BOT_PERMISSIONS.has(key) || row[key] === true
  }
  return out
}

/**
 * PostgREST `or` filter matching a query against username, display name and
 * description. Characters with meaning in the filter grammar (`,` `(` `)` `:`
 * `"` `\`) and the wildcards `*` `%` are dropped. Null when nothing is left.
 */
export function botSearchFilter(query: string): string | null {
  const term = query.replace(/[,():"\\*%]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 64)
  if (!term) return null
  return ['username', 'display_name', 'bio'].map(col => `${col}.ilike.*${term}*`).join(',')
}

export interface BotEndpoints {
  gatewayUrl: string
  restBaseUrl: string
}

/** Public endpoints behind the instance's /bot-gateway reverse-proxy prefix. */
export function buildBotEndpoints(instanceOrigin: string): BotEndpoints {
  const { gatewayUrl, apiUrl } = buildBridgeGatewayUrls(instanceOrigin, false)
  return { gatewayUrl, restBaseUrl: `${apiUrl}/api/v1` }
}
