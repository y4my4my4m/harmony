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
  loadBridgeForBot,
  normalizeSetupCode,
  sanitizeStatusReport,
} from '../bridge/bridgeConfig.js'

// One body for every redeem failure: unknown, used, expired and malformed codes read alike.
const INVALID_CODE = { error: 'Invalid or expired setup code', code: 'invalid_code' } as const

// Host secrets shorter than this leave GET /hosted disabled.
export const MIN_HOST_SECRET_LENGTH = 32

export interface BridgeV2Options {
  // Per-IP attempts on POST /redeem per window.
  redeemLimit?: number
  redeemWindowMs?: number
  // Per-IP failed GET /hosted requests per window.
  hostedFailureLimit?: number
  hostedWindowMs?: number
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

    this.router.post('/redeem', redeemLimiter, this.redeem.bind(this))
    this.router.get('/hosted', hostedLimiter, this.hosted.bind(this))

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

  private async hosted(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store')
    const secret = config.bridge?.hostSecret ?? ''
    if (secret.length < MIN_HOST_SECRET_LENGTH) {
      return res.status(404).json({ error: 'Not found' })
    }
    const given = req.get('x-bridge-host-secret') ?? ''
    if (!secretsEqual(given, secret)) {
      return res.status(401).json({ error: 'Invalid host secret' })
    }

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
