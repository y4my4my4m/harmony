/**
 * Discord REST client for "Migrate from Discord": the identify-only user OAuth, and the bot-token
 * reads the sync runner needs. Never logs or returns a token in an error reason.
 */

import { DISCORD_API_BASE } from '../bridge/instanceBot.js'

export const DISCORD_OAUTH_BASE = process.env.DISCORD_OAUTH_BASE ?? 'https://discord.com'
const CDN = 'https://cdn.discordapp.com'
const DEFAULT_TIMEOUT_MS = 10_000
/** Longest we wait on a 429 before giving up on the single retry. */
const MAX_RETRY_WAIT_MS = 15_000

export type DiscordResult<T> = { ok: true; value: T } | { ok: false; status: number; reason: string }

export interface DiscordClientOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export interface DiscordUser {
  id: string
  username: string
  global_name: string | null
  avatar_url: string | null
  banner_url: string | null
  accent_color: number | null
}

export interface DiscordRole {
  id: string
  name: string
  color: number
  position: number
  permissions: string
}

export interface DiscordMember {
  role_ids: string[]
  nick: string | null
  joined_at: string
  timed_out_until: string | null
  guild_avatar_url: string | null
  guild_banner_url: string | null
  user: DiscordUser
}

interface RawResponse {
  status: number
  body: any
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** One request, one retry after a 429. Network errors and timeouts become status 0. */
async function request(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
  opts: DiscordClientOptions,
): Promise<{ ok: true; res: RawResponse } | { ok: false; status: number; reason: string }> {
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response
    try {
      response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      return { ok: false, status: 0, reason: timedOut ? 'timeout' : 'network_error' }
    }
    let body: any = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    if (response.status === 429) {
      if (attempt === 1) return { ok: false, status: 429, reason: 'rate_limited' }
      const retryAfter = Number(body?.retry_after ?? response.headers.get('retry-after') ?? 1)
      const ms = Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 0) * 1000, MAX_RETRY_WAIT_MS) : 1000
      await wait(ms)
      continue
    }
    return { ok: true, res: { status: response.status, body } }
  }
  return { ok: false, status: 429, reason: 'rate_limited' }
}

function failure(status: number, body: any): { ok: false; status: number; reason: string } {
  const code = body && typeof body.code === 'number' ? ` code ${body.code}` : ''
  return { ok: false, status, reason: `discord_http_${status}${code}` }
}

async function botGet(
  token: string,
  path: string,
  opts: DiscordClientOptions,
): Promise<{ ok: true; res: RawResponse } | { ok: false; status: number; reason: string }> {
  return request(`${DISCORD_API_BASE}${path}`, { headers: { Authorization: `Bot ${token}` } }, opts)
}

/** Fetch `path` with a bot token and map a 2xx body; any other status is a failure. */
async function botGetMapped<T>(
  token: string,
  path: string,
  map: (body: any) => T,
  opts: DiscordClientOptions,
): Promise<DiscordResult<T>> {
  const r = await botGet(token, path, opts)
  if (!r.ok) return r
  if (r.res.status < 200 || r.res.status >= 300) return failure(r.res.status, r.res.body)
  return { ok: true, value: map(r.res.body) }
}

function mapUser(raw: any): DiscordUser {
  const id = String(raw.id)
  return {
    id,
    username: String(raw.username ?? ''),
    global_name: raw.global_name ?? null,
    avatar_url: raw.avatar ? `${CDN}/avatars/${id}/${raw.avatar}.png?size=256` : null,
    banner_url: raw.banner ? `${CDN}/banners/${id}/${raw.banner}.png?size=600` : null,
    accent_color: typeof raw.accent_color === 'number' ? raw.accent_color : null,
  }
}

export function migrateAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'identify',
    response_type: 'code',
    prompt: 'none',
    redirect_uri: redirectUri,
    state,
  })
  return `${DISCORD_OAUTH_BASE}/oauth2/authorize?${params.toString()}`
}

export async function exchangeUserCode(
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  opts: DiscordClientOptions = {},
): Promise<DiscordResult<{ accessToken: string }>> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
  })
  const r = await request(
    `${DISCORD_API_BASE}/oauth2/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
    opts,
  )
  if (!r.ok) return r
  if (r.res.status < 200 || r.res.status >= 300) return failure(r.res.status, r.res.body)
  const accessToken = r.res.body?.access_token
  if (typeof accessToken !== 'string' || !accessToken) return { ok: false, status: r.res.status, reason: 'no_access_token' }
  return { ok: true, value: { accessToken } }
}

export async function fetchCurrentUser(
  accessToken: string,
  opts: DiscordClientOptions = {},
): Promise<DiscordResult<DiscordUser>> {
  const r = await request(`${DISCORD_API_BASE}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } }, opts)
  if (!r.ok) return r
  if (r.res.status < 200 || r.res.status >= 300) return failure(r.res.status, r.res.body)
  return { ok: true, value: mapUser(r.res.body) }
}

export function fetchUser(botToken: string, userId: string, opts: DiscordClientOptions = {}): Promise<DiscordResult<DiscordUser>> {
  return botGetMapped(botToken, `/users/${userId}`, mapUser, opts)
}

export function fetchGuildRoles(botToken: string, guildId: string, opts: DiscordClientOptions = {}): Promise<DiscordResult<DiscordRole[]>> {
  return botGetMapped(
    botToken,
    `/guilds/${guildId}/roles`,
    (body: any[]) =>
      body
        .filter((r) => !r.managed && String(r.id) !== guildId)
        .map((r) => ({
          id: String(r.id),
          name: String(r.name),
          color: Number(r.color ?? 0),
          position: Number(r.position ?? 0),
          permissions: String(r.permissions ?? '0'),
        })),
    opts,
  )
}

function mapMember(raw: any, guildId: string): DiscordMember {
  const user = mapUser(raw.user)
  return {
    role_ids: (raw.roles ?? []).map(String),
    nick: raw.nick ?? null,
    joined_at: String(raw.joined_at),
    timed_out_until: raw.communication_disabled_until ?? null,
    guild_avatar_url: raw.avatar ? `${CDN}/guilds/${guildId}/users/${user.id}/avatars/${raw.avatar}.png?size=256` : null,
    guild_banner_url: raw.banner ? `${CDN}/guilds/${guildId}/users/${user.id}/banners/${raw.banner}.png?size=600` : null,
    user,
  }
}

export async function fetchGuildMember(
  botToken: string,
  guildId: string,
  userId: string,
  opts: DiscordClientOptions = {},
): Promise<DiscordResult<{ present: false } | { present: true; member: DiscordMember }>> {
  const r = await botGet(botToken, `/guilds/${guildId}/members/${userId}`, opts)
  if (!r.ok) return r
  if (r.res.status === 404 && r.res.body?.code === 10007) return { ok: true, value: { present: false } }
  if (r.res.status < 200 || r.res.status >= 300) return failure(r.res.status, r.res.body)
  return { ok: true, value: { present: true, member: mapMember(r.res.body, guildId) } }
}

export async function fetchBan(
  botToken: string,
  guildId: string,
  userId: string,
  opts: DiscordClientOptions = {},
): Promise<DiscordResult<boolean>> {
  const r = await botGet(botToken, `/guilds/${guildId}/bans/${userId}`, opts)
  if (!r.ok) return r
  if (r.res.status === 404) return { ok: true, value: false }
  if (r.res.status < 200 || r.res.status >= 300) return failure(r.res.status, r.res.body)
  return { ok: true, value: true }
}

export function fetchApplication(botToken: string, opts: DiscordClientOptions = {}): Promise<DiscordResult<{ id: string }>> {
  return botGetMapped(botToken, '/oauth2/applications/@me', (body) => ({ id: String(body.id) }), opts)
}

/** A permission overwrite: type 0 is a role, type 1 a member; allow and deny are Discord bitfields (decimal strings). */
export interface DiscordPermissionOverwrite {
  id: string
  type: number
  allow: string
  deny: string
}

export interface DiscordChannel {
  id: string
  name: string
  type: number
  permission_overwrites: DiscordPermissionOverwrite[]
}

export function fetchGuildChannels(
  botToken: string,
  guildId: string,
  opts: DiscordClientOptions = {},
): Promise<DiscordResult<DiscordChannel[]>> {
  return botGetMapped(
    botToken,
    `/guilds/${guildId}/channels`,
    (body: any[]) =>
      body.map((c) => ({
        id: String(c.id),
        name: String(c.name ?? ''),
        type: Number(c.type ?? 0),
        permission_overwrites: (c.permission_overwrites ?? []).map((o: any) => ({
          id: String(o.id ?? ''),
          type: Number(o.type),
          allow: String(o.allow ?? '0'),
          deny: String(o.deny ?? '0'),
        })),
      })),
    opts,
  )
}

const BAN_MEMBERS = 1n << 2n
const ADMINISTRATOR = 1n << 3n

/** Whether the bot can ban in the guild: BAN_MEMBERS or ADMINISTRATOR across @everyone and its roles. */
export async function fetchBotPermissionsInGuild(
  botToken: string,
  guildId: string,
  opts: DiscordClientOptions = {},
): Promise<DiscordResult<{ canBan: boolean }>> {
  const app = await fetchApplication(botToken, opts)
  if (!app.ok) return app
  const member = await fetchGuildMember(botToken, guildId, app.value.id, opts)
  if (!member.ok) return member
  if (!member.value.present) return { ok: false, status: 404, reason: 'bot_not_in_guild' }
  const roles = await botGetMapped(botToken, `/guilds/${guildId}/roles`, (body: any[]) => body, opts)
  if (!roles.ok) return roles
  const held = new Set(member.value.member.role_ids)
  let bits = 0n
  for (const role of roles.value) {
    const id = String(role.id)
    if (id === guildId || held.has(id)) bits |= BigInt(role.permissions ?? '0')
  }
  return { ok: true, value: { canBan: (bits & (BAN_MEMBERS | ADMINISTRATOR)) !== 0n } }
}
