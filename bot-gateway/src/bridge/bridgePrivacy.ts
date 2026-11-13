import { Router, type Request, type Response, type RequestHandler } from 'express'
import { supabase } from '../config/supabase.js'
import type { BotRequest } from '../auth/BotAuthMiddleware.js'
import { DISCORD_PLATFORM, SNOWFLAKE, type BridgeRow } from './bridgeConfig.js'

/**
 * Bridge v2 privacy endpoints, mounted under /bridge/v2/privacy behind the bridgeBot middleware
 * (bot token, rate limit, req.bridge). Scope: the bridge's server, platform discord; `:id` is a
 * Discord user id. Thin over the bridge_privacy_* RPCs (20261112600001).
 *
 *   GET    /optouts        {version, remote_user_ids}
 *   GET    /optouts/:id    {opted_out, since, source}
 *   PUT    /optouts/:id    opt out
 *   DELETE /optouts/:id    opt in; a manager's or admin's removal stays
 *   POST   /erase          {remote_user_id}: opt out, then delete the user's relayed and imported
 *                          rows. 202 {opted_out, erased, more}; with more the rest is deleted in
 *                          the background. 429 erase_recent inside ERASE_COOLDOWN_MS of the last
 *                          request for the same user.
 */

type PrivacyRequest = BotRequest & { bridge?: BridgeRow }

// Rows per bridge_privacy_erase call.
const ERASE_BATCH = 200
// Batches one background erase runs: 2,000,000 rows.
const ERASE_MAX_BATCHES = 10_000
const ERASE_PAUSE_MS = 50
// An erase also scans the server's relayed reactions and AutoMod events, which have no author index.
export const ERASE_COOLDOWN_MS = 60_000
const ERASE_TRACKED_MAX = 10_000

interface EraseResult {
  opted_out?: boolean
  erased?: number
  more?: boolean
}

/** `${serverId}:${remoteUserId}` -> when the last erase was accepted; true while its tail runs. */
const eraseSeen = new Map<string, number>()
const eraseRunning = new Set<string>()

function remember(key: string, at: number) {
  eraseSeen.delete(key)
  eraseSeen.set(key, at)
  for (const old of eraseSeen.keys()) {
    if (eraseSeen.size <= ERASE_TRACKED_MAX) break
    eraseSeen.delete(old)
  }
}

async function eraseBatch(serverId: string, remoteUserId: string) {
  return supabase.rpc('bridge_privacy_erase', {
    p_server_id: serverId,
    p_platform: DISCORD_PLATFORM,
    p_remote_user_id: remoteUserId,
    p_limit: ERASE_BATCH,
  })
}

/** Repeats the erase until nothing is left. One loop per user and server. */
async function eraseRest(serverId: string, remoteUserId: string, key: string): Promise<void> {
  if (eraseRunning.has(key)) return
  eraseRunning.add(key)
  try {
    for (let i = 0; i < ERASE_MAX_BATCHES; i++) {
      await new Promise((resolve) => setTimeout(resolve, ERASE_PAUSE_MS))
      const { data, error } = await eraseBatch(serverId, remoteUserId)
      if (error) {
        console.error(`bridge_privacy_erase for server ${serverId} failed:`, error.code, error.message)
        return
      }
      if ((data as EraseResult | null)?.more !== true) return
    }
    console.warn(`bridge_privacy_erase for server ${serverId} stopped after ${ERASE_MAX_BATCHES} batches`)
  } finally {
    eraseRunning.delete(key)
  }
}

/** For tests: forgets every erase seen. */
export function resetEraseCooldown() {
  eraseSeen.clear()
  eraseRunning.clear()
}

/** `guard` goes on each route, not on the mount: the rate limiter buckets by `req.route`. */
export function createBridgePrivacyRouter(guard: RequestHandler[] = []): Router {
  const router = Router()

  router.param('id', (_req, res, next, id) => {
    if (!SNOWFLAKE.test(String(id))) return res.status(400).json({ code: 'invalid_remote_user' })
    next()
  })

  const serverId = (req: Request) => (req as PrivacyRequest).bridge!.server_id

  const handler = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
    async (req, res) => {
      try {
        await fn(req, res)
      } catch (error) {
        console.error('bridge privacy request failed:', error)
        if (!res.headersSent) res.status(500).json({ error: 'Privacy request failed' })
      }
    }

  const failed = (res: Response, rpc: string, error: { code?: string; message?: string }) => {
    if (error.message === 'invalid_remote_user') return res.status(400).json({ code: 'invalid_remote_user' })
    console.error(`${rpc} failed:`, error.code, error.message)
    res.status(500).json({ error: 'Privacy request failed' })
  }

  router.get('/optouts', ...guard, handler(async (req, res) => {
    const { data, error } = await supabase.rpc('bridge_privacy_optout_ids', {
      p_server_id: serverId(req),
      p_platform: DISCORD_PLATFORM,
    })
    if (error) return failed(res, 'bridge_privacy_optout_ids', error)
    const body = (data ?? {}) as { version?: unknown; remote_user_ids?: unknown }
    res.json({
      version: typeof body.version === 'string' ? body.version : '0:0',
      remote_user_ids: Array.isArray(body.remote_user_ids) ? body.remote_user_ids : [],
    })
  }))

  router.get('/optouts/:id', ...guard, handler(async (req, res) => {
    const { data, error } = await supabase.rpc('bridge_privacy_status', {
      p_server_id: serverId(req),
      p_platform: DISCORD_PLATFORM,
      p_remote_user_id: req.params.id,
    })
    if (error) return failed(res, 'bridge_privacy_status', error)
    res.json(data)
  }))

  const setOptout = (optedOut: boolean) => handler(async (req, res) => {
    const { data, error } = await supabase.rpc('bridge_privacy_set_optout', {
      p_server_id: serverId(req),
      p_platform: DISCORD_PLATFORM,
      p_remote_user_id: req.params.id,
      p_opted_out: optedOut,
    })
    if (error) return failed(res, 'bridge_privacy_set_optout', error)
    res.json(data)
  })
  router.put('/optouts/:id', ...guard, setOptout(true))
  router.delete('/optouts/:id', ...guard, setOptout(false))

  router.post('/erase', ...guard, handler(async (req, res) => {
    const remoteUserId = (req.body as { remote_user_id?: unknown } | undefined)?.remote_user_id
    if (typeof remoteUserId !== 'string' || !SNOWFLAKE.test(remoteUserId)) {
      return res.status(400).json({ code: 'invalid_remote_user' })
    }
    const server = serverId(req)
    const key = `${server}:${remoteUserId}`
    const now = Date.now()
    const last = eraseSeen.get(key)
    if (eraseRunning.has(key) || (last !== undefined && now - last < ERASE_COOLDOWN_MS)) {
      const wait = Math.max(1, Math.ceil((ERASE_COOLDOWN_MS - (now - (last ?? now))) / 1000))
      return res.set('Retry-After', String(wait)).status(429).json({ code: 'erase_recent', retry_after: wait })
    }
    remember(key, now)

    const { data, error } = await eraseBatch(server, remoteUserId)
    if (error) {
      eraseSeen.delete(key)
      return failed(res, 'bridge_privacy_erase', error)
    }
    const result = (data ?? {}) as EraseResult
    if (result.more === true) {
      eraseRest(server, remoteUserId, key).catch((err) => console.error('bridge erase tail failed:', err))
    }
    res.status(202).json({ opted_out: true, erased: result.erased ?? 0, more: result.more === true })
  }))

  return router
}
