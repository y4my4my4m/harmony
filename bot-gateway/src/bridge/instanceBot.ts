/**
 * Discord OAuth2 for the instance bot (bridge v2.1): the authorize redirect, the code exchange,
 * and the return to Server Settings → Discord Bridge.
 */

export const DISCORD_API_BASE = 'https://discord.com/api/v10'
export const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize'

/**
 * Permission bits the bridge program needs in a guild
 * (https://discord.com/developers/docs/topics/permissions): its README's invite set (View
 * Channels, Send Messages, Embed Links, Attach Files, Read Message History, Add Reactions,
 * Manage Webhooks) plus Use External Emojis.
 */
export const INSTANCE_BOT_PERMISSION_BITS = {
  addReactions: 1n << 6n,
  viewChannel: 1n << 10n,
  sendMessages: 1n << 11n,
  embedLinks: 1n << 14n,
  attachFiles: 1n << 15n,
  readMessageHistory: 1n << 16n,
  useExternalEmojis: 1n << 18n,
  manageWebhooks: 1n << 29n,
} as const

/** 537250880. */
export const INSTANCE_BOT_PERMISSIONS = Object.values(INSTANCE_BOT_PERMISSION_BITS)
  .reduce((acc, bit) => acc | bit, 0n)
  .toString()

export const INSTANCE_BOT_SCOPES = 'bot applications.commands'

/** discord_bridge_instance_link: 32 random bytes as lowercase hex. */
export const LINK_STATE = /^[0-9a-f]{64}$/

/** Charset and length an authorization code must have to be sent to Discord. */
const AUTHORIZATION_CODE = /^[A-Za-z0-9_.-]{1,256}$/

export const LINK_ERRORS = [
  'state_invalid',
  'guild_linked_elsewhere',
  'discord_denied',
  'exchange_failed',
  'limit_reached',
] as const
export type LinkError = (typeof LINK_ERRORS)[number]

export function isAuthorizationCode(value: unknown): value is string {
  return typeof value === 'string' && AUTHORIZATION_CODE.test(value)
}

/** The OAuth2 redirect URI registered on the Discord application. `base` is configuredBaseUrl(). */
export function discordCallbackUrl(base: string): string {
  return `${base}/bot-gateway/bridge/v2/discord/callback`
}

export function discordAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: INSTANCE_BOT_SCOPES,
    permissions: INSTANCE_BOT_PERMISSIONS,
    response_type: 'code',
    integration_type: '0',
    redirect_uri: redirectUri,
    state,
  })
  // URLSearchParams writes a space as '+'; Discord's documented form is %20.
  return `${DISCORD_AUTHORIZE_URL}?${params.toString().replace(/\+/g, '%20')}`
}

/** Server Settings → Discord Bridge of `serverId` (src/router: /server/:serverId, ?section=discord-bridge). */
export function bridgeSettingsUrl(base: string, serverId: string, outcome: { linked: true } | { error: LinkError }): string {
  const params = new URLSearchParams({ section: 'discord-bridge' })
  if ('linked' in outcome) params.set('linked', '1')
  else params.set('link_error', outcome.error)
  return `${base}/server/${encodeURIComponent(serverId)}?${params.toString()}`
}

export interface ExchangedGuild {
  id: string
  name: string | null
}

export type ExchangeResult = { ok: true; guild: ExchangedGuild } | { ok: false; reason: string }

const SNOWFLAKE = /^[0-9]{1,20}$/

/**
 * POST /oauth2/token with grant_type authorization_code. The guild is the token response's
 * `guild` object, present for the bot scope. `reason` carries Discord's error code or the HTTP
 * status, never the code or a credential.
 */
export async function exchangeAuthorizationCode(
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  timeoutMs = 10_000,
): Promise<ExchangeResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  })
  let response: Response
  try {
    response = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : 'network' }
  }

  let parsed: unknown = null
  try {
    parsed = await response.json()
  } catch {
    parsed = null
  }
  const payload = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  if (!response.ok) {
    const code = typeof payload.error === 'string' && /^[a-z_]{1,64}$/.test(payload.error) ? payload.error : ''
    return { ok: false, reason: `HTTP ${response.status}${code ? ` ${code}` : ''}` }
  }

  const guild = payload.guild && typeof payload.guild === 'object' ? (payload.guild as Record<string, unknown>) : null
  if (!guild || typeof guild.id !== 'string' || !SNOWFLAKE.test(guild.id)) {
    return { ok: false, reason: 'no guild in the token response' }
  }
  const name = typeof guild.name === 'string' ? guild.name.slice(0, 100) : null
  return { ok: true, guild: { id: guild.id, name } }
}

/** DELETE /users/@me/guilds/{guild.id} as the bot. Resolves to the HTTP status, 0 on a network error. */
export async function leaveGuild(botToken: string, guildId: string, timeoutMs = 10_000): Promise<number> {
  try {
    const response = await fetch(`${DISCORD_API_BASE}/users/@me/guilds/${guildId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.status
  } catch {
    return 0
  }
}
