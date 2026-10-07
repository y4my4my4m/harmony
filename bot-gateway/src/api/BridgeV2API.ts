import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express'
import { rateLimit } from 'express-rate-limit'
import { createHash, timingSafeEqual } from 'crypto'
import { supabase, config } from '../config/supabase.js'
import { botAuthMiddleware, botRateLimit, type BotRequest } from '../auth/BotAuthMiddleware.js'
import { botCanSeeChannel, loadEveryoneLayer, loadInstall } from '../auth/botPermissions.js'
import {
  type BridgeRow,
  DIRECTIONS,
  SNOWFLAKE,
  UUID,
  bridgeUrls,
  buildBridgeConfig,
  configuredBaseUrl,
  loadBridgeForBot,
  normalizeSetupCode,
  sanitizeStatusReport,
} from '../bridge/bridgeConfig.js'
import {
  LINK_ERRORS,
  LINK_STATE,
  type LinkError,
  bridgeSettingsUrl,
  discordAuthorizeUrl,
  discordCallbackUrl,
  exchangeAuthorizationCode,
  isAuthorizationCode,
  leaveGuild,
} from '../bridge/instanceBot.js'

// One body for every redeem failure: unknown, used, expired and malformed codes read alike.
const INVALID_CODE = { error: 'Invalid or expired setup code', code: 'invalid_code' } as const

// Host secrets shorter than this leave GET /hosted disabled.
export const MIN_HOST_SECRET_LENGTH = 32

export interface BridgeV2Options {
  // Per-IP attempts on POST /redeem per window.
  redeemLimit?: number
  redeemWindowMs?: number
  // Per-IP failed GET /hosted and /hosted/instance requests per window.
  hostedFailureLimit?: number
  hostedWindowMs?: number
  // Per-IP requests on GET /discord/authorize and /discord/callback together, per window.
  linkLimit?: number
  linkWindowMs?: number
}

/** discord_bridge_instance_link_check(): server_id is null for a state never issued. */
interface LinkCheck {
  bridge_id: string | null
  server_id: string | null
  error: LinkError | null
}

type BridgeRequest = BotRequest & { bridge?: BridgeRow }

/** Compares SHA-256 digests: equal lengths, so timingSafeEqual applies whatever the input lengths. */
export function secretsEqual(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

// SQLSTATE raised by the discord_bridge_* functions -> HTTP status.
function statusForSqlState(code: string | undefined): number {
  switch (code) {
    case '22023':
    case '23514':
      return 400
    case '42501':
      return 403
    case 'P0002':
      return 404
    case '23505':
      return 409
    default:
      return 500
  }
}

/** The coded error a discord_bridge_instance_* function raised (its message), else exchange_failed. */
function linkErrorOf(error: { message?: string } | null): LinkError {
  const message = error?.message ?? ''
  return (LINK_ERRORS as readonly string[]).includes(message) ? (message as LinkError) : 'exchange_failed'
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

async function hostingEnabled(): Promise<boolean | null> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_value')
    .eq('config_key', 'discord_bridge_hosting_enabled')
    .maybeSingle()
  if (error) {
    console.error('discord_bridge_hosting_enabled lookup failed:', error.message)
    return null
  }
  const raw = (data as { config_value?: unknown } | null)?.config_value
  return raw === true || (typeof raw === 'string' && raw.toLowerCase() === 'true')
}

/**
 * /bridge/v2: Discord bridge v2 onboarding, configuration and hosting.
 *
 *   POST   /redeem                         setup code -> bridge bot token; per-IP limited
 *   GET    /hosted                         X-Bridge-Host-Secret; hosted bridges with tokens
 *   GET    /hosted/instance                X-Bridge-Host-Secret; the instance bot and its bridges
 *   GET    /discord/authorize?state        302 to Discord's OAuth2 consent for the instance bot
 *   GET    /discord/callback               OAuth2 redirect URI; links the guild, 302 to the app
 *   GET    /config                         bridge bot only
 *   POST   /status                         bridge bot only; heartbeat and Discord snapshot
 *   POST   /pairs                          bridge bot only; Discord-side /bridge link
 *   DELETE /pairs/:discordChannelId        bridge bot only; Discord-side /bridge unlink
 */
export class BridgeV2API {
  public router: Router

  constructor(options: BridgeV2Options = {}) {
    this.router = Router()

    const redeemLimiter = rateLimit({
      windowMs: options.redeemWindowMs ?? 15 * 60 * 1000,
      limit: options.redeemLimit ?? 10,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many attempts; try again later', code: 'rate_limited' },
    })
    // Counts refused secrets only: a runner polling while hosting is off is not locked out.
    const hostedLimiter = rateLimit({
      windowMs: options.hostedWindowMs ?? 15 * 60 * 1000,
      limit: options.hostedFailureLimit ?? 30,
      skipSuccessfulRequests: true,
      requestWasSuccessful: (_req, res) => res.statusCode !== 401,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many attempts; try again later', code: 'rate_limited' },
    })

    const linkLimiter = rateLimit({
      windowMs: options.linkWindowMs ?? 15 * 60 * 1000,
      limit: options.linkLimit ?? 30,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many attempts; try again later', code: 'rate_limited' },
    })

    this.router.post('/redeem', redeemLimiter, this.redeem.bind(this))
    this.router.get('/hosted', hostedLimiter, this.hosted.bind(this))
    this.router.get('/hosted/instance', hostedLimiter, this.hostedInstance.bind(this))
    this.router.get('/discord/authorize', linkLimiter, this.discordAuthorize.bind(this))
    this.router.get('/discord/callback', linkLimiter, this.discordCallback.bind(this))

    const bridgeBot: RequestHandler[] = [
      botAuthMiddleware as RequestHandler,
      botRateLimit as RequestHandler,
      this.requireBridge.bind(this) as RequestHandler,
    ]
    this.router.get('/config', ...bridgeBot, this.getConfig.bind(this) as RequestHandler)
    this.router.post('/status', ...bridgeBot, this.postStatus.bind(this) as RequestHandler)
    this.router.post('/pairs', ...bridgeBot, this.postPair.bind(this) as RequestHandler)
    this.router.delete('/pairs/:discordChannelId', ...bridgeBot, this.deletePair.bind(this) as RequestHandler)
  }

  private async redeem(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store')
    const code = normalizeSetupCode((req.body as { code?: unknown } | undefined)?.code)
    if (!code) {
      return res.status(400).json(INVALID_CODE)
    }

    const { data, error } = await supabase.rpc('discord_bridge_redeem_code', { p_code: code })
    if (error) {
      console.error('discord_bridge_redeem_code failed:', error.code, error.message)
      return res.status(500).json({ error: 'Redeem failed' })
    }
    const redeemed = data as { bridge_id?: string; server_id?: string; harmony_token?: string } | null
    if (!redeemed?.bridge_id || !redeemed.harmony_token) {
      return res.status(400).json(INVALID_CODE)
    }

    res.json({
      bridge_id: redeemed.bridge_id,
      server_id: redeemed.server_id,
      harmony_token: redeemed.harmony_token,
      ...bridgeUrls(req),
    })
  }

  /** False after answering: 404 while BRIDGE_HOST_SECRET is unusable, 401 on a wrong secret. */
  private hostSecretAccepted(req: Request, res: Response): boolean {
    res.set('Cache-Control', 'no-store')
    const secret = config.bridge?.hostSecret ?? ''
    if (secret.length < MIN_HOST_SECRET_LENGTH) {
      res.status(404).json({ error: 'Not found' })
      return false
    }
    const given = req.get('x-bridge-host-secret') ?? ''
    if (!secretsEqual(given, secret)) {
      res.status(401).json({ error: 'Invalid host secret' })
      return false
    }
    return true
  }

  private async hosted(req: Request, res: Response) {
    if (!this.hostSecretAccepted(req, res)) return

    const enabled = await hostingEnabled()
    if (enabled === null) return res.status(503).json({ error: 'Hosting state unavailable' })
    if (!enabled) return res.status(404).json({ error: 'Not found' })

    const { data, error } = await supabase.rpc('discord_bridge_hosted_list')
    if (error) {
      console.error('discord_bridge_hosted_list failed:', error.code, error.message)
      return res.status(error.code === '0A000' ? 404 : 500).json({ error: 'Hosted list unavailable' })
    }
    const rows = (Array.isArray(data) ? data : []) as Array<{
      bridge_id: string
      harmony_token: string
      discord_token: string
    }>
    res.json(rows.map((r) => ({ bridge_id: r.bridge_id, harmony_token: r.harmony_token, discord_token: r.discord_token })))
  }

  /** discord_bridge_instance_hosted(): 404 while the instance bot is off or unconfigured. */
  private async hostedInstance(req: Request, res: Response) {
    if (!this.hostSecretAccepted(req, res)) return

    const { data, error } = await supabase.rpc('discord_bridge_instance_hosted')
    if (error) {
      console.error('discord_bridge_instance_hosted failed:', error.code, error.message)
      return res.status(error.code === '0A000' ? 404 : 500).json({ error: 'Instance bot unavailable' })
    }
    if (!data || typeof data !== 'object') return res.status(404).json({ error: 'Not found' })
    const hosted = data as {
      application_id: string
      discord_token: string
      presence: boolean
      bridges: Array<{ bridge_id: string; harmony_token: string; discord_guild_id: string }>
    }
    res.json({
      application_id: hosted.application_id,
      discord_token: hosted.discord_token,
      presence: hosted.presence === true,
      bridges: (Array.isArray(hosted.bridges) ? hosted.bridges : []).map((b) => ({
        bridge_id: b.bridge_id,
        harmony_token: b.harmony_token,
        discord_guild_id: b.discord_guild_id,
      })),
    })
  }

  private async linkCheck(state: string, guildId: string | null): Promise<LinkCheck | null> {
    const { data, error } = await supabase.rpc('discord_bridge_instance_link_check', {
      p_state: state,
      p_guild_id: guildId,
    })
    if (error || !data || typeof data !== 'object') {
      if (error) console.error('discord_bridge_instance_link_check failed:', error.code, error.message)
      return null
    }
    return data as LinkCheck
  }

  /** OAuth2 client credentials; null while the instance bot is off, unconfigured or unreadable. */
  private async clientCredentials(): Promise<{ client_id: string; client_secret: string } | null> {
    const { data, error } = await supabase.rpc('discord_bridge_instance_bot_secrets')
    if (error) {
      console.error('discord_bridge_instance_bot_secrets failed:', error.code, error.message)
      return null
    }
    const row = (Array.isArray(data) ? data[0] : data) as { client_id?: unknown; client_secret?: unknown } | null
    if (!row || typeof row.client_id !== 'string' || typeof row.client_secret !== 'string') return null
    return { client_id: row.client_id, client_secret: row.client_secret }
  }

  /** A state that names no server: nowhere in the app to return to. */
  private invalidLinkPage(res: Response, base: string) {
    const home = escapeHtml(base)
    res
      .status(400)
      .type('html')
      .send(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Discord link expired</title>' +
          '<p>This Discord link is invalid or has expired. In Harmony, open Server Settings, Discord Bridge, ' +
          'and choose Add to Discord again.</p>' +
          `<p><a href="${home}/">Open Harmony</a></p></html>`,
      )
  }

  /**
   * 302 to Discord's consent screen. The state is checked first, so an expired one returns to
   * the app before the user authorizes anything.
   */
  private async discordAuthorize(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store')
    const base = configuredBaseUrl()
    if (!base) return res.status(503).json({ error: 'INSTANCE_DOMAIN or PUBLIC_URL is not set' })

    const state = typeof req.query.state === 'string' ? req.query.state : ''
    const check = LINK_STATE.test(state) ? await this.linkCheck(state, null) : null
    if (LINK_STATE.test(state) && !check) return res.status(503).json({ error: 'Link check unavailable' })
    if (!check?.server_id) return this.invalidLinkPage(res, base)
    if (check.error) return res.redirect(302, bridgeSettingsUrl(base, check.server_id, { error: check.error }))

    const credentials = await this.clientCredentials()
    if (!credentials) {
      return res.redirect(302, bridgeSettingsUrl(base, check.server_id, { error: 'exchange_failed' }))
    }
    res.redirect(302, discordAuthorizeUrl(credentials.client_id, discordCallbackUrl(base), state))
  }

  /**
   * Discord's redirect after consent. With "Requires OAuth2 Code Grant" the bot joins the guild
   * when the code is exchanged, so every refusal that can be decided before the exchange is.
   * The guild linked is the token response's; the query's guild_id only refuses early. A
   * refusal after the exchange leaves the guild when no instance bridge links it.
   */
  private async discordCallback(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store')
    const base = configuredBaseUrl()
    if (!base) return res.status(503).json({ error: 'INSTANCE_DOMAIN or PUBLIC_URL is not set' })

    const query = req.query as Record<string, unknown>
    const state = typeof query.state === 'string' ? query.state : ''
    const discordError = typeof query.error === 'string' ? query.error : ''
    const queryGuild = typeof query.guild_id === 'string' && SNOWFLAKE.test(query.guild_id) ? query.guild_id : null

    const check = LINK_STATE.test(state) ? await this.linkCheck(state, discordError ? null : queryGuild) : null
    if (LINK_STATE.test(state) && !check) return res.status(503).json({ error: 'Link check unavailable' })
    if (!check?.server_id) return this.invalidLinkPage(res, base)
    const serverId = check.server_id
    const back = (outcome: { linked: true } | { error: LinkError }) =>
      res.redirect(302, bridgeSettingsUrl(base, serverId, outcome))

    if (check.error) return back({ error: check.error })
    if (discordError) return back({ error: discordError === 'access_denied' ? 'discord_denied' : 'exchange_failed' })
    if (!isAuthorizationCode(query.code)) return back({ error: 'exchange_failed' })

    const credentials = await this.clientCredentials()
    if (!credentials) return back({ error: 'exchange_failed' })

    const exchanged = await exchangeAuthorizationCode({
      clientId: credentials.client_id,
      clientSecret: credentials.client_secret,
      code: query.code,
      redirectUri: discordCallbackUrl(base),
    })
    if (!exchanged.ok) {
      console.warn(`Discord code exchange for bridge ${check.bridge_id} failed: ${exchanged.reason}`)
      return back({ error: 'exchange_failed' })
    }

    const { data, error } = await supabase.rpc('discord_bridge_instance_link_complete', {
      p_state: state,
      p_guild_id: exchanged.guild.id,
      p_guild_name: exchanged.guild.name,
    })
    if (error) {
      const code = linkErrorOf(error)
      console.warn(`discord_bridge_instance_link_complete for bridge ${check.bridge_id} refused:`, error.code, code)
      if (code !== 'guild_linked_elsewhere') {
        this.leaveUnlinkedGuild(exchanged.guild.id).catch((err) =>
          console.error('Leaving an unlinked guild failed:', err instanceof Error ? err.message : err),
        )
      }
      return back({ error: code })
    }
    const linked = data as { server_id?: string } | null
    res.redirect(302, bridgeSettingsUrl(base, linked?.server_id ?? serverId, { linked: true }))
  }

  /** Best effort: the bot leaves a guild it joined through a refused link. */
  private async leaveUnlinkedGuild(guildId: string): Promise<void> {
    const { data: linked, error } = await supabase
      .from('discord_bridges')
      .select('id')
      .eq('mode', 'instance')
      .eq('discord_guild_id', guildId)
      .limit(1)
    if (error || !Array.isArray(linked) || linked.length > 0) return
    const { data: hosted, error: hostedError } = await supabase.rpc('discord_bridge_instance_hosted')
    const token = (hosted as { discord_token?: unknown } | null)?.discord_token
    if (hostedError || typeof token !== 'string') return
    const status = await leaveGuild(token, guildId)
    if (status !== 204) console.warn(`Leaving unlinked guild ${guildId} answered ${status || 'no response'}`)
  }

  /** The authenticated bot must be a bridge's bot_id. */
  private async requireBridge(req: BridgeRequest, res: Response, next: NextFunction) {
    const bridge = await loadBridgeForBot(req.bot!.id)
    if (bridge === 'error') return res.status(503).json({ error: 'Bridge lookup unavailable' })
    if (!bridge) return res.status(403).json({ error: 'Bot is not a Discord bridge' })
    req.bridge = bridge
    next()
  }

  private async getConfig(req: BridgeRequest, res: Response) {
    const built = await buildBridgeConfig(req.bridge!, bridgeUrls(req).base_url)
    if (!built) return res.status(503).json({ error: 'Bridge configuration unavailable' })
    res.json(built)
  }

  private async postStatus(req: BridgeRequest, res: Response) {
    const report = sanitizeStatusReport(req.body)
    if (!report) return res.status(400).json({ error: 'Body must be a JSON object' })

    const { data, error } = await supabase.rpc('discord_bridge_report_status', {
      p_bot_id: req.bot!.id,
      p_status: report.status,
      p_snapshot: report.snapshot,
      p_version: report.version,
    })
    if (error) {
      console.error('discord_bridge_report_status failed:', error.code, error.message)
      return res.status(statusForSqlState(error.code)).json({ error: 'Status not stored' })
    }
    const stored = data as { discord_guild_id?: string | null } | null
    if (!stored) return res.status(403).json({ error: 'Bot is not a Discord bridge' })
    res.json({ ok: true, discord_guild_id: stored.discord_guild_id ?? null })
  }

  private async postPair(req: BridgeRequest, res: Response) {
    const body = (req.body ?? {}) as Record<string, unknown>
    const discordChannelId = body.discord_channel_id
    const harmonyChannelId = body.harmony_channel_id
    const direction = body.direction ?? 'both'
    const discordChannelName = typeof body.discord_channel_name === 'string' ? body.discord_channel_name : null

    if (typeof discordChannelId !== 'string' || !SNOWFLAKE.test(discordChannelId)) {
      return res.status(400).json({ error: 'discord_channel_id must be a Discord id' })
    }
    if (typeof harmonyChannelId !== 'string' || !UUID.test(harmonyChannelId)) {
      return res.status(400).json({ error: 'harmony_channel_id must be a uuid' })
    }
    if (typeof direction !== 'string' || !(DIRECTIONS as readonly string[]).includes(direction)) {
      return res.status(400).json({ error: `direction must be one of ${DIRECTIONS.join(', ')}` })
    }

    // The Discord side links only channels the bridge bot already reads.
    const bridge = req.bridge!
    const { data: channel, error: channelError } = await supabase
      .from('channels')
      .select('id, server_id')
      .eq('id', harmonyChannelId)
      .maybeSingle()
    if (channelError) return res.status(503).json({ error: 'Channel lookup unavailable' })
    if (!channel || (channel as { server_id: string }).server_id !== bridge.server_id) {
      return res.status(400).json({ error: 'harmony_channel_id is not a channel of this server' })
    }
    const install = await loadInstall(req.bot!.id, bridge.server_id)
    const layer = install ? await loadEveryoneLayer(bridge.server_id, harmonyChannelId) : null
    if (!install || !layer || !botCanSeeChannel(install, layer, harmonyChannelId)) {
      return res.status(403).json({ error: 'The bridge bot cannot see that Harmony channel' })
    }

    const { data, error } = await supabase.rpc('discord_bridge_bot_pair', {
      p_bot_id: req.bot!.id,
      p_harmony_channel_id: harmonyChannelId,
      p_discord_channel_id: discordChannelId,
      p_discord_channel_name: discordChannelName,
      p_direction: direction,
    })
    if (error) {
      const status = statusForSqlState(error.code)
      if (status === 500) console.error('discord_bridge_bot_pair failed:', error.code, error.message)
      return res.status(status).json({ error: status === 500 ? 'Pairing failed' : error.message })
    }
    res.status(201).json({
      id: data,
      harmony_channel_id: harmonyChannelId,
      discord_channel_id: discordChannelId,
      direction,
    })
  }

  private async deletePair(req: BridgeRequest, res: Response) {
    const discordChannelId = req.params.discordChannelId
    if (!SNOWFLAKE.test(discordChannelId)) {
      return res.status(400).json({ error: 'discordChannelId must be a Discord id' })
    }
    const { data, error } = await supabase.rpc('discord_bridge_bot_unpair', {
      p_bot_id: req.bot!.id,
      p_discord_channel_id: discordChannelId,
    })
    if (error) {
      const status = statusForSqlState(error.code)
      if (status === 500) console.error('discord_bridge_bot_unpair failed:', error.code, error.message)
      return res.status(status).json({ error: status === 500 ? 'Unpairing failed' : error.message })
    }
    if (data !== true) return res.status(404).json({ error: 'That Discord channel is not paired' })
    res.status(204).end()
  }
}
