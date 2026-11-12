import { Router, type Request, type Response, type RequestHandler } from 'express'
import { rateLimit } from 'express-rate-limit'
import { randomBytes } from 'crypto'
import { supabase, createUserClient, fetchMailerAutoconfirm } from '../config/supabase.js'
import { configuredBaseUrl } from '../bridge/bridgeConfig.js'
import { MIGRATION_CALLBACK_PATH } from '../bridge/instanceBot.js'
import { meetsAssurance } from '../utils/sessionAssurance.js'
import {
  type DiscordResult,
  exchangeUserCode,
  fetchApplication,
  fetchBotPermissionsInGuild,
  fetchCurrentUser,
  fetchGuildChannels,
  type DiscordChannel,
  fetchGuildMember,
  fetchGuildRoles,
  migrateAuthorizeUrl,
} from '../migration/discordClient.js'
import { buildMemberOverridesSnapshot, buildRolesSnapshot } from '../migration/discordPermissions.js'

const LINK_TOKEN = /^[0-9a-f]{48}$/
const STATE = /^[0-9a-f]{64}$/
const TICKET = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USERNAME = /^[a-z0-9_]{3,24}$/
const OAUTH_CODE = /^[A-Za-z0-9._~-]{1,512}$/
/** Discord channel types a bridge can pair: text, announcement, forum. */
const PAIRABLE_CHANNEL_TYPES: ReadonlySet<number> = new Set([0, 5, 15])
const LINK_STATE_TTL_MS = 10 * 60 * 1000

export interface MigrationOptions {
  /** Syncs one linked member now (Task 7's MigrationSyncRunner.syncOne). userId is the Harmony profile id. */
  syncOne: (serverId: string, userId: string) => Promise<void>
  // Per-IP requests per window, per route.
  limit?: number
  windowMs?: number
}

type RefreshError = 'credentials_missing' | 'token_invalid' | 'bot_not_in_guild'

interface MigrationRow {
  server_id: string
  state: string
  discord_guild_id: string | null
  credential_source: string | null
  link_token: string
}

interface Credentials {
  client_id: string
  client_secret: string
  bot_token: string
}

/** The Discord failure as a refresh error; null when Discord was merely unavailable (network, 5xx, 429). */
function refreshErrorOf(failure: { status: number; reason: string }): RefreshError | null {
  if (failure.reason === 'bot_not_in_guild') return 'bot_not_in_guild'
  if (failure.status === 401) return 'token_invalid'
  if (failure.status === 403 || failure.status === 404) return 'bot_not_in_guild'
  return null
}

function bearer(req: Request): string | null {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) return null
  return auth.slice('Bearer '.length).trim() || null
}

/**
 * /bridge/v2/migrate: "Migrate from Discord" setup checks, the identify-only OAuth hop, account
 * creation for Discord members without an account, and an immediate sync for a linked member.
 *
 *   POST /:serverId/refresh      admin JWT; roles snapshot, bot permissions and readiness warnings
 *   GET  /authorize?token        302 to Discord; the link state lives 10 minutes
 *   GET  /callback?code&state    Discord's redirect URI; creates a claim ticket, 302 to the app
 *   POST /account                {ticket, username, email, password}; creates the GoTrue user
 *   POST /me/:serverId/sync      member JWT; runs syncOne now
 */
export class MigrationAPI {
  public router: Router
  private readonly syncOne: MigrationOptions['syncOne']

  constructor(options: MigrationOptions) {
    this.syncOne = options.syncOne
    this.router = Router()

    // One limiter per route, so a route's traffic never spends another's allowance.
    const limiter = (): RequestHandler =>
      rateLimit({
        windowMs: options.windowMs ?? 15 * 60 * 1000,
        limit: options.limit ?? 30,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Too many attempts; try again later', code: 'rate_limited' },
      })

    this.router.get('/authorize', limiter(), this.safe(this.authorize))
    this.router.get('/callback', limiter(), this.safe(this.callback))
    this.router.post('/account', limiter(), this.safe(this.account))
    this.router.post('/me/:serverId/sync', limiter(), this.safe(this.mySync))
    this.router.post('/:serverId/refresh', limiter(), this.safe(this.refresh))
  }

  /** Nothing escapes a handler as an unhandled rejection: a throw is a 500 JSON error. */
  private safe(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
    return (req, res) => {
      handler.call(this, req, res).catch((err) => {
        console.error('migration route failed:', err instanceof Error ? err.message : 'unknown error')
        if (!res.headersSent) res.status(500).json({ error: 'Internal error' })
      })
    }
  }

  private redirectUri(base: string): string {
    return `${base}${MIGRATION_CALLBACK_PATH}`
  }

  private appUrl(base: string, token: string, params: Record<string, string>): string {
    return `${base}/migrate/${encodeURIComponent(token)}?${new URLSearchParams(params).toString()}`
  }

  private async loadMigration(by: { token: string } | { serverId: string }): Promise<MigrationRow | null | 'error'> {
    const query = supabase
      .from('discord_migrations')
      .select('server_id, state, discord_guild_id, credential_source, link_token')
    const { data, error } = await ('token' in by ? query.eq('link_token', by.token) : query.eq('server_id', by.serverId)).maybeSingle()
    if (error) {
      console.error('discord_migrations lookup failed:', error.code, error.message)
      return 'error'
    }
    return (data as MigrationRow | null) ?? null
  }

  /** The migration's Discord credentials; null when they cannot be resolved. */
  private async credentials(serverId: string): Promise<Credentials | null | 'error'> {
    const { data, error } = await supabase.rpc('discord_migration_credentials', { p_server_id: serverId })
    if (error) {
      if ((error.message ?? '').includes('MIGRATION_CREDENTIALS_MISSING')) return null
      console.error('discord_migration_credentials failed:', error.code, error.message)
      return 'error'
    }
    const row = (Array.isArray(data) ? data[0] : data) as Partial<Credentials> | null
    if (!row || typeof row.client_id !== 'string' || typeof row.client_secret !== 'string' || typeof row.bot_token !== 'string') {
      return null
    }
    return { client_id: row.client_id, client_secret: row.client_secret, bot_token: row.bot_token }
  }

  /** Runs a Discord call; a throw (a malformed 2xx body) becomes a failure result. */
  private async discord<T>(call: () => Promise<DiscordResult<T>>): Promise<DiscordResult<T>> {
    try {
      return await call()
    } catch {
      return { ok: false, status: 502, reason: 'malformed_response' }
    }
  }

  /**
   * The bridge source reads its application id from the bridge's bot, which only the hosted-list
   * RPC can unseal. Fills discord_migration_secrets.client_id; false when it cannot be filled.
   */
  private async fillBridgeClientId(serverId: string): Promise<boolean> {
    const { data: secrets } = await supabase
      .from('discord_migration_secrets')
      .select('client_id')
      .eq('server_id', serverId)
      .maybeSingle()
    if (!secrets || (secrets as { client_id: string | null }).client_id) return false
    const { data: bridge } = await supabase
      .from('discord_bridges')
      .select('id')
      .eq('server_id', serverId)
      .eq('mode', 'hosted')
      .maybeSingle()
    const bridgeId = (bridge as { id?: string } | null)?.id
    if (!bridgeId) return false
    const { data: hosted } = await supabase.rpc('discord_bridge_hosted_list')
    const entry = (Array.isArray(hosted) ? hosted : []).find((h: { bridge_id: string }) => h.bridge_id === bridgeId) as
      | { discord_token?: string }
      | undefined
    if (!entry?.discord_token) return false
    const app = await this.discord(() => fetchApplication(entry.discord_token as string))
    if (!app.ok) return false
    const { error } = await supabase.from('discord_migration_secrets').update({ client_id: app.value.id }).eq('server_id', serverId)
    if (error) {
      console.error('discord_migration_secrets client_id write failed:', error.code, error.message)
      return false
    }
    return true
  }

  // ---------------------------------------------------------------- refresh

  private async refresh(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store')
    const jwt = bearer(req)
    if (!jwt) return res.status(401).json({ ok: false, error: 'unauthenticated' })
    const serverId = String(req.params.serverId ?? '')
    if (!UUID.test(serverId)) return res.status(400).json({ ok: false, error: 'invalid_server' })

    const { data: userData, error: userError } = await supabase.auth.getUser(jwt)
    if (userError || !userData?.user || !meetsAssurance(userData.user, jwt)) {
      return res.status(401).json({ ok: false, error: 'unauthenticated' })
    }
    const { data: allowed, error: allowedError } = await createUserClient(jwt).rpc('can_manage_discord_bridge', {
      p_server_id: serverId,
    })
    if (allowedError) {
      console.error('can_manage_discord_bridge failed:', allowedError.code, allowedError.message)
      return res.status(500).json({ ok: false, error: 'check_failed' })
    }
    if (allowed !== true) return res.status(403).json({ ok: false, error: 'forbidden' })

    const migration = await this.loadMigration({ serverId })
    if (migration === 'error') return res.status(500).json({ ok: false, error: 'lookup_failed' })
    if (!migration || !migration.discord_guild_id) return res.json({ ok: false, error: 'credentials_missing' })
    const guildId = migration.discord_guild_id

    let creds = await this.credentials(serverId)
    if (creds === null && migration.credential_source === 'bridge' && (await this.fillBridgeClientId(serverId))) {
      creds = await this.credentials(serverId)
    }
    if (creds === 'error') return res.status(500).json({ ok: false, error: 'lookup_failed' })
    if (!creds) return res.json({ ok: false, error: 'credentials_missing' })

    const refused = (failure: { status: number; reason: string }) => {
      const error = refreshErrorOf(failure)
      return error ? res.json({ ok: false, error }) : res.status(502).json({ ok: false, error: 'discord_unavailable' })
    }

    const roles = await this.discord(() => fetchGuildRoles(creds.bot_token, guildId))
    if (!roles.ok) return refused(roles)
    const perms = await this.discord(() => fetchBotPermissionsInGuild(creds.bot_token, guildId))
    if (!perms.ok) return refused(perms)
    const channels = await this.discord(() => fetchGuildChannels(creds.bot_token, guildId))
    if (!channels.ok) return refused(channels)

    const { data: names, error: namesError } = await supabase.rpc('permission_bit_names')
    if (namesError || !Array.isArray(names)) {
      console.error('permission_bit_names failed:', namesError?.code, namesError?.message)
      return res.status(500).json({ ok: false, error: 'lookup_failed' })
    }

    const snapshot = buildRolesSnapshot(roles.value, names as string[])
    const stored = await supabase.rpc('discord_migration_store_discord_roles', { p_server_id: serverId, p_roles: snapshot })
    if (stored.error) {
      console.error('discord_migration_store_discord_roles failed:', stored.error.code, stored.error.message)
      return res.status(500).json({ ok: false, error: 'store_failed' })
    }

    const { error: banError } = await supabase
      .from('discord_migrations')
      .update({ bot_can_ban: perms.value.canBan })
      .eq('server_id', serverId)
    if (banError) console.error('bot_can_ban write failed:', banError.code, banError.message)

    const overrides = await supabase.rpc('discord_migration_store_member_overrides', {
      p_server_id: serverId,
      p_overrides: buildMemberOverridesSnapshot(channels.value, names as string[]),
    })
    if (overrides.error) {
      console.error('discord_migration_store_member_overrides failed:', overrides.error.code, overrides.error.message)
      return res.status(500).json({ ok: false, error: 'store_failed' })
    }

    const warnings = await this.readinessWarnings(serverId, channels.value)
    if (warnings === 'error') return res.status(500).json({ ok: false, error: 'lookup_failed' })
    const w = await supabase.rpc('discord_migration_store_warnings', { p_server_id: serverId, p_warnings: warnings })
    if (w.error) {
      console.error('discord_migration_store_warnings failed:', w.error.code, w.error.message)
      return res.status(500).json({ ok: false, error: 'store_failed' })
    }

    res.json({ ok: true, roles: snapshot.length, canBan: perms.value.canBan })
  }

  private async readinessWarnings(
    serverId: string,
    channels: DiscordChannel[],
  ) {
    const { data: bridges, error } = await supabase.from('discord_bridges').select('id').eq('server_id', serverId)
    if (error) {
      console.error('discord_bridges lookup failed:', error.code, error.message)
      return 'error' as const
    }
    const bridgeIds = ((bridges ?? []) as Array<{ id: string }>).map((b) => b.id)
    let paired = new Set<string>()
    if (bridgeIds.length > 0) {
      const { data: rows, error: rowsError } = await supabase
        .from('discord_bridge_channels')
        .select('discord_channel_id')
        .in('bridge_id', bridgeIds)
      if (rowsError) {
        console.error('discord_bridge_channels lookup failed:', rowsError.code, rowsError.message)
        return 'error' as const
      }
      paired = new Set(((rows ?? []) as Array<{ discord_channel_id: string }>).map((r) => r.discord_channel_id))
    }
    return {
      unpaired_channels: channels.filter((c) => PAIRABLE_CHANNEL_TYPES.has(c.type) && !paired.has(c.id)).map((c) => c.name),
      member_overrides: channels.reduce((n, c) => n + c.permission_overwrites.filter((o) => o.type === 1).length, 0),
    }
  }

  // -------------------------------------------------------------- authorize

  private async authorize(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store')
    const base = configuredBaseUrl()
    if (!base) return res.status(503).json({ error: 'INSTANCE_DOMAIN or PUBLIC_URL is not set' })
    const token = typeof req.query.token === 'string' ? req.query.token : ''
    if (!LINK_TOKEN.test(token)) return res.status(400).json({ error: 'Invalid token' })

    const back = (error: string) => res.redirect(302, this.appUrl(base, token, { error }))
    const migration = await this.loadMigration({ token })
    if (migration === 'error') return back('unavailable')
    if (!migration || migration.state !== 'open') return back('closed')

    const creds = await this.credentials(migration.server_id)
    if (!creds || creds === 'error') return back('unavailable')

    const state = randomBytes(32).toString('hex')
    const { error } = await supabase.from('discord_migration_link_states').insert({
      state,
      server_id: migration.server_id,
      expires_at: new Date(Date.now() + LINK_STATE_TTL_MS).toISOString(),
    })
    if (error) {
      console.error('discord_migration_link_states insert failed:', error.code, error.message)
      return back('unavailable')
    }
    res.redirect(302, migrateAuthorizeUrl(creds.client_id, this.redirectUri(base), state))
  }

  // --------------------------------------------------------------- callback

  private async callback(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store')
    const base = configuredBaseUrl()
    if (!base) return res.status(503).json({ error: 'INSTANCE_DOMAIN or PUBLIC_URL is not set' })
    const query = req.query as Record<string, unknown>
    const state = typeof query.state === 'string' ? query.state : ''
    if (!STATE.test(state)) return res.status(400).json({ error: 'Invalid or expired state' })

    // A state is used once: read it, then delete it whatever happens next.
    const { data: row, error: stateError } = await supabase
      .from('discord_migration_link_states')
      .select('server_id, expires_at')
      .eq('state', state)
      .maybeSingle()
    if (stateError) {
      console.error('discord_migration_link_states lookup failed:', stateError.code, stateError.message)
      return res.status(500).json({ error: 'State lookup failed' })
    }
    const linkState = row as { server_id: string; expires_at: string } | null
    if (linkState) await supabase.from('discord_migration_link_states').delete().eq('state', state)
    if (!linkState || Date.parse(linkState.expires_at) <= Date.now()) {
      return res.status(400).json({ error: 'Invalid or expired state' })
    }

    const migration = await this.loadMigration({ serverId: linkState.server_id })
    if (migration === 'error' || !migration) return res.status(500).json({ error: 'Migration lookup failed' })
    const token = migration.link_token
    const back = (error: string) => res.redirect(302, this.appUrl(base, token, { error }))

    if (typeof query.error === 'string') return back(query.error === 'access_denied' ? 'denied' : 'exchange_failed')
    if (typeof query.code !== 'string' || !OAUTH_CODE.test(query.code)) return back('exchange_failed')
    if (migration.state !== 'open') return back('closed')
    if (!migration.discord_guild_id) return back('unavailable')
    const guildId = migration.discord_guild_id

    const creds = await this.credentials(migration.server_id)
    if (!creds || creds === 'error') return back('unavailable')

    const code = query.code
    const exchanged = await this.discord(() =>
      exchangeUserCode({ clientId: creds.client_id, clientSecret: creds.client_secret, code, redirectUri: this.redirectUri(base) }),
    )
    if (!exchanged.ok) {
      console.warn(`migration code exchange failed: ${exchanged.reason}`)
      return back('exchange_failed')
    }
    const user = await this.discord(() => fetchCurrentUser(exchanged.value.accessToken))
    if (!user.ok) {
      console.warn(`migration identify failed: ${user.reason}`)
      return back('exchange_failed')
    }
    const member = await this.discord(() => fetchGuildMember(creds.bot_token, guildId, user.value.id))
    if (!member.ok) {
      console.warn(`migration member lookup failed: ${member.reason}`)
      return back('unavailable')
    }
    if (!member.value.present) return back('not_member')

    // Built outside the call: the rpc contract test reads every `key:` inside the call object as an argument name.
    const discordUser = {
      id: user.value.id,
      username: user.value.username,
      global_name: user.value.global_name,
      avatar_url: user.value.avatar_url,
    }
    const { data, error } = await supabase.rpc('discord_migration_create_claim', {
      p_server_id: migration.server_id,
      p_discord_user: discordUser,
      p_discord_role_ids: member.value.member.role_ids,
      p_discord_joined_at: member.value.member.joined_at,
    })
    if (error) {
      console.error('discord_migration_create_claim failed:', error.code, error.message)
      return back('unavailable')
    }
    const claim = data as { ticket?: string; error?: string } | null
    if (claim?.error) return back(claim.error.toLowerCase())
    if (!claim?.ticket) return back('unavailable')
    res.redirect(302, this.appUrl(base, token, { ticket: claim.ticket, username: user.value.username }))
  }

  // ---------------------------------------------------------------- account

  private async accountCreationEnabled(): Promise<boolean | null> {
    const { data, error } = await supabase
      .from('instance_config')
      .select('config_value')
      .eq('config_key', 'discord_migration_account_creation')
      .maybeSingle()
    if (error) {
      console.error('discord_migration_account_creation lookup failed:', error.message)
      return null
    }
    const raw = (data as { config_value?: unknown } | null)?.config_value
    // Absent means the default, true.
    if (raw === undefined || raw === null) return true
    return raw === true || (typeof raw === 'string' && raw.toLowerCase() === 'true')
  }

  private async account(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store')
    const body = (req.body ?? {}) as Record<string, unknown>
    const ticket = typeof body.ticket === 'string' ? body.ticket : ''
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!TICKET.test(ticket)) return res.status(400).json({ error: 'invalid_ticket' })
    if (!USERNAME.test(username)) return res.status(400).json({ error: 'username_invalid' })
    if (!email || email.length > 320 || !password) return res.status(400).json({ error: 'invalid_request' })

    const enabled = await this.accountCreationEnabled()
    if (enabled === null) return res.status(503).json({ error: 'unavailable' })
    if (!enabled) return res.status(403).json({ error: 'account_creation_disabled' })

    const { data: claim, error: claimError } = await supabase
      .from('discord_migration_claims')
      .select('ticket, auth_user_id, expires_at')
      .eq('ticket', ticket)
      .maybeSingle()
    if (claimError) {
      console.error('discord_migration_claims lookup failed:', claimError.code, claimError.message)
      return res.status(500).json({ error: 'lookup_failed' })
    }
    const c = claim as { auth_user_id: string | null; expires_at: string } | null
    if (!c || Date.parse(c.expires_at) <= Date.now() || c.auth_user_id) {
      return res.status(400).json({ error: 'invalid_ticket' })
    }

    const { data: taken, error: takenError } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', username)
      .eq('is_local', true)
      .limit(1)
    if (takenError) {
      console.error('profiles username lookup failed:', takenError.code, takenError.message)
      return res.status(500).json({ error: 'lookup_failed' })
    }
    if (Array.isArray(taken) && taken.length > 0) return res.status(409).json({ error: 'username_taken' })

    // Sign-up needs a confirmed email unless GoTrue auto-confirms; unreadable settings fail safe to confirming.
    const autoconfirm = await fetchMailerAutoconfirm()
    if (autoconfirm === null) console.warn('GoTrue settings unreadable; creating the migrated account as unconfirmed')
    const needsConfirmation = autoconfirm !== true
    const created = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: !needsConfirmation,
      user_metadata: { username },
    })
    if (created.error || !created.data?.user) {
      const err = created.error as { code?: string; status?: number; message?: string } | null
      if (err?.code === 'email_exists' || err?.code === 'user_already_exists') return res.status(409).json({ error: 'email_exists' })
      if (err?.code === 'weak_password') return res.status(400).json({ error: 'weak_password' })
      if (err?.code === 'validation_failed' || err?.code === 'email_address_invalid') return res.status(400).json({ error: 'invalid_request' })
      if (/username/i.test(err?.message ?? '')) return res.status(400).json({ error: 'username_invalid' })
      console.error('auth.admin.createUser failed:', err?.code, err?.status)
      return res.status(500).json({ error: 'create_failed' })
    }
    const authUserId = created.data.user.id

    const bound = await supabase.rpc('discord_migration_bind_claim', { p_ticket: ticket, p_auth_user_id: authUserId })
    if (bound.error) {
      // The ticket expired or was bound meanwhile: do not leave an orphan account behind.
      const removed = await supabase.auth.admin.deleteUser(authUserId).catch((err: unknown) => ({ error: err as { message?: string } }))
      if (removed?.error) {
        console.error(`migration rollback: deleting auth user ${authUserId} failed:`, removed.error.message ?? 'unknown error')
      }
      const expired = (bound.error.message ?? '').includes('TICKET_EXPIRED')
      if (!expired) console.error('discord_migration_bind_claim failed:', bound.error.code, bound.error.message)
      return res.status(expired ? 400 : 500).json({ error: expired ? 'invalid_ticket' : 'bind_failed' })
    }

    if (needsConfirmation) {
      try {
        await supabase.auth.resend({ type: 'signup', email })
      } catch {
        // The member can request another confirmation mail from the sign-in page.
      }
    }
    res.json({ ok: true, needsConfirmation })
  }

  // ------------------------------------------------------------------- sync

  private async mySync(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store')
    const jwt = bearer(req)
    if (!jwt) return res.status(401).json({ error: 'unauthenticated' })
    const serverId = String(req.params.serverId ?? '')
    if (!UUID.test(serverId)) return res.status(400).json({ error: 'invalid_server' })

    const { data: userData, error: userError } = await supabase.auth.getUser(jwt)
    if (userError || !userData?.user || !meetsAssurance(userData.user, jwt)) {
      return res.status(401).json({ error: 'unauthenticated' })
    }
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle()
    if (profileError) return res.status(500).json({ error: 'lookup_failed' })
    const profileId = (profile as { id?: string } | null)?.id
    if (!profileId) return res.status(404).json({ error: 'not_linked' })

    const { data: link, error: linkError } = await supabase
      .from('discord_migration_links')
      .select('user_id')
      .eq('server_id', serverId)
      .eq('user_id', profileId)
      .eq('status', 'active')
      .maybeSingle()
    if (linkError) return res.status(500).json({ error: 'lookup_failed' })
    const migration = link ? await this.loadMigration({ serverId }) : null
    if (migration === 'error') return res.status(500).json({ error: 'lookup_failed' })
    if (!link || !migration || migration.state !== 'open') return res.status(404).json({ error: 'not_linked' })

    try {
      await this.syncOne(serverId, profileId)
    } catch (err) {
      console.error('migration syncOne failed:', err instanceof Error ? err.message : 'unknown error')
      return res.status(502).json({ error: 'sync_failed' })
    }
    res.json({ ok: true })
  }
}
