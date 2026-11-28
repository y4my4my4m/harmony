import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express'
import { supabase, config } from '../config/supabase.js'
import { botAuthMiddleware, botRateLimit, type BotRequest } from '../auth/BotAuthMiddleware.js'
import { UUID, bridgeUrls, normalizeSetupCode } from '../bridge/bridgeConfig.js'
import {
  MATRIX_PLATFORM,
  type MatrixBridgeRow,
  buildMatrixBridgeConfig,
  isMatrixUserId,
  loadMatrixBridgeForBot,
  sanitizeMatrixHostStatus,
  sanitizeMatrixStatusReport,
} from '../bridge/matrixBridgeConfig.js'
import { MATRIX_ROOM_ID } from '../bridge/matrixRooms.js'
import { createBridgePrivacyRouter } from '../bridge/bridgePrivacy.js'
import { bridgeChannelPlatform, serverOfChannel } from '../bridge/memberConsent.js'
import type { InstallSink } from './BotRestAPI.js'
import {
  INVALID_CODE,
  type HostLimitOptions,
  type RedeemLimitOptions,
  hostRateLimit,
  hostSecretAccepted,
  redeemRateLimit,
  statusForSqlState,
} from './BridgeV2API.js'

// One body for every room code that links nothing.
const INVALID_ROOM_CODE = { error: 'Invalid or expired room code', code: 'invalid_code' } as const

type MatrixBridgeRequest = BotRequest & { matrixBridge?: MatrixBridgeRow; privacyServerId?: string }

/**
 * /bridge/v2/matrix: onboarding and configuration of a managed Matrix bridge (20261126100001).
 *
 *   POST /redeem        setup code -> bridge bot token; per-IP limited as /bridge/v2/redeem
 *   GET  /config        bridge bot only
 *   POST /status        bridge bot only; report of the bridge, its rooms and its pairs
 *   /privacy/...        bridge bot, or a custom Matrix bot with ?channel_id=; opt-outs and erase of
 *                       Matrix users (bridge/bridgePrivacy.ts, ids are MXIDs)
 *
 * And the instance's Matrix bridge host (20261126100003, 20261126100004), with X-Bridge-Host-Secret
 * equal to MATRIX_BRIDGE_HOST_SECRET:
 *
 *   GET  /host          hosted bridges and the instance's connection, with their tokens
 *   POST /host/status   the host's report
 *   POST /host/link     a room code posted in a room
 */
export class MatrixBridgeAPI {
  public router: Router

  constructor(options: RedeemLimitOptions & HostLimitOptions = {}, private readonly installs?: InstallSink) {
    this.router = Router()
    this.router.post('/redeem', redeemRateLimit(options), this.redeem.bind(this))

    const hostLimiter = hostRateLimit(options)
    this.router.get('/host', hostLimiter, this.host.bind(this))
    this.router.post('/host/status', hostLimiter, this.hostStatus.bind(this))
    this.router.post('/host/link', hostLimiter, this.hostLink.bind(this))

    const bot: RequestHandler[] = [botAuthMiddleware as RequestHandler, botRateLimit as RequestHandler]
    const bridgeBot: RequestHandler[] = [...bot, this.requireBridge.bind(this) as RequestHandler]
    this.router.get('/config', ...bridgeBot, this.getConfig.bind(this) as RequestHandler)
    this.router.post('/status', ...bridgeBot, this.postStatus.bind(this) as RequestHandler)
    this.router.use('/privacy', createBridgePrivacyRouter(
      [...bot, this.requirePrivacyServer.bind(this) as RequestHandler],
      {
        platform: MATRIX_PLATFORM,
        validId: isMatrixUserId,
        eraseField: 'user_id',
        serverId: (req) => (req as MatrixBridgeRequest).privacyServerId!,
      },
    ))
  }

  private async redeem(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store')
    const code = normalizeSetupCode((req.body as { code?: unknown } | undefined)?.code, 'MX')
    if (!code) {
      return res.status(400).json(INVALID_CODE)
    }

    const { data, error } = await supabase.rpc('matrix_bridge_redeem_code', { p_code: code })
    if (error) {
      console.error('matrix_bridge_redeem_code failed:', error.code, error.message)
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

  /** The authenticated bot must be a managed bridge's bot_id. */
  private async requireBridge(req: MatrixBridgeRequest, res: Response, next: NextFunction) {
    const bridge = await loadMatrixBridgeForBot(req.bot!.id)
    if (bridge === 'error') return res.status(503).json({ error: 'Bridge lookup unavailable' })
    if (!bridge) return res.status(403).json({ error: 'Bot is not a managed Matrix bridge' })
    req.matrixBridge = bridge
    next()
  }

  /**
   * The server whose opt-outs the request is about: the managed bridge's, or for a custom Matrix bot
   * the server of the channel it names and relays to Matrix.
   */
  private async requirePrivacyServer(req: MatrixBridgeRequest, res: Response, next: NextFunction) {
    const bridge = await loadMatrixBridgeForBot(req.bot!.id)
    if (bridge === 'error') return res.status(503).json({ error: 'Bridge lookup unavailable' })
    if (bridge) {
      req.privacyServerId = bridge.server_id
      return next()
    }

    const channelId = req.query.channel_id
    if (typeof channelId !== 'string' || !UUID.test(channelId)) {
      return res.status(400).json({ error: 'channel_id must name a channel this bot relays to Matrix', code: 'channel_required' })
    }
    try {
      if (await bridgeChannelPlatform(req.bot!.id, channelId) !== MATRIX_PLATFORM) {
        return res.status(403).json({ error: 'No Matrix bridge registered for this channel' })
      }
    } catch {
      return res.status(503).json({ error: 'Bridge registration unavailable' })
    }
    const serverId = await serverOfChannel(channelId)
    if (!serverId) return res.status(503).json({ error: 'Channel lookup unavailable' })
    req.privacyServerId = serverId
    next()
  }

  private async getConfig(req: MatrixBridgeRequest, res: Response) {
    const built = await buildMatrixBridgeConfig(req.bot!.id, bridgeUrls(req).base_url)
    if (!built) return res.status(503).json({ error: 'Bridge configuration unavailable' })
    res.json(built)
  }

  private async postStatus(req: MatrixBridgeRequest, res: Response) {
    const report = sanitizeMatrixStatusReport(req.body)
    if (!report) return res.status(400).json({ error: 'Body must be a JSON object' })

    const { data, error } = await supabase.rpc('matrix_bridge_report_status', {
      p_bot_id: req.bot!.id,
      p_connection: report.connection,
      p_status: report.status,
      p_snapshot: report.snapshot,
      p_version: report.version,
      p_pairs: report.pairs,
    })
    if (error) {
      console.error('matrix_bridge_report_status failed:', error.code, error.message)
      return res.status(statusForSqlState(error.code)).json({ error: 'Status not stored' })
    }
    if (!data) return res.status(403).json({ error: 'Bot is not a managed Matrix bridge' })
    res.json({ ok: true })
  }

  /**
   * What the host runs; nothing of a mode that is off. A failed lookup answers 503 and no partial list:
   * the host stops what a list leaves out. 0A000: Vault is absent, so nothing is stored.
   */
  private async host(req: Request, res: Response) {
    if (!hostSecretAccepted(req, res, config.bridge?.matrixHostSecret)) return

    const [hosted, instance] = await Promise.all([
      supabase.rpc('matrix_bridge_hosted_list'),
      supabase.rpc('matrix_bridge_instance_hosted'),
    ])
    for (const [what, { error }] of [['matrix_bridge_hosted_list', hosted], ['matrix_bridge_instance_hosted', instance]] as const) {
      if (!error || error.code === '0A000') continue
      console.error(`${what} failed:`, error.code, error.message)
      return res.status(503).json({ error: 'Host list unavailable' })
    }
    const rows = (Array.isArray(hosted.data) ? hosted.data : []) as Array<Record<string, unknown>>
    const own = (instance.data && typeof instance.data === 'object' ? instance.data : null) as Record<string, unknown> | null
    const bridges = (own && Array.isArray(own.bridges) ? own.bridges : []) as Array<Record<string, unknown>>
    res.json({
      hosted: rows.map((row) => ({
        bridge_id: row.bridge_id,
        harmony_token: row.harmony_token,
        homeserver_url: row.homeserver_url,
        access_token: row.access_token,
      })),
      instance: own && {
        connection: own.connection,
        homeserver_url: own.homeserver_url,
        server_name: own.server_name,
        sender_localpart: own.sender_localpart,
        as_token: own.as_token,
        hs_token: own.hs_token,
        access_token: own.access_token,
        bridges: bridges.map((bridge) => ({ bridge_id: bridge.bridge_id, harmony_token: bridge.harmony_token })),
      },
    })
  }

  private async hostStatus(req: Request, res: Response) {
    if (!hostSecretAccepted(req, res, config.bridge?.matrixHostSecret)) return
    const report = sanitizeMatrixHostStatus(req.body)
    if (!report) return res.status(400).json({ error: 'Body must be a JSON object' })

    const { error } = await supabase.rpc('bridge_host_report', {
      p_platform: MATRIX_PLATFORM,
      p_version: report.version,
      p_status: report.status,
    })
    if (error) {
      console.error('bridge_host_report failed:', error.code, error.message)
      return res.status(statusForSqlState(error.code)).json({ error: 'Status not stored' })
    }
    res.json({ ok: true })
  }

  private async hostLink(req: Request, res: Response) {
    if (!hostSecretAccepted(req, res, config.bridge?.matrixHostSecret)) return
    const { code: typed, room_id, sender } = (req.body ?? {}) as Record<string, unknown>
    const invalid = { error: 'Expected code, room_id and sender', code: 'invalid_request' } as const
    if (typeof room_id !== 'string' || !MATRIX_ROOM_ID.test(room_id) || /\p{Cs}/u.test(room_id) || !isMatrixUserId(sender)) {
      return res.status(400).json(invalid)
    }
    const code = normalizeSetupCode(typed, 'ML')
    if (!code) return res.status(400).json(INVALID_ROOM_CODE)

    const { data, error } = await supabase.rpc('matrix_bridge_link_room', {
      p_code: code,
      p_room_id: room_id,
      p_sender: sender,
    })
    if (error?.code === '55000' && error.message === 'channel_encrypted') {
      return res.status(409).json({ error: 'The channel is end-to-end encrypted', code: 'channel_encrypted' })
    }
    if (error?.code === '22023') return res.status(400).json(invalid)
    if (error) {
      console.error('matrix_bridge_link_room failed:', error.code, error.message)
      return res.status(503).json({ error: 'Room not linked' })
    }
    const linked = data as { bridge_id?: string; server_name?: string; channel_id?: string; channel_name?: string } | null
    if (!linked?.bridge_id) return res.status(400).json(INVALID_ROOM_CODE)
    // The link put the channel in the install's list.
    if (linked.channel_id) await this.installs?.installsChanged(linked.channel_id)
    res.json({
      bridge_id: linked.bridge_id,
      server_name: linked.server_name,
      channel_id: linked.channel_id,
      channel_name: linked.channel_name,
    })
  }
}
