import { Router, type Request, type Response, type RequestHandler } from 'express'
import { supabase } from '../config/supabase.js'
import type { BotRequest } from '../auth/BotAuthMiddleware.js'
import { DISCORD_PLATFORM, SNOWFLAKE, type BridgeRow } from './bridgeConfig.js'
import { MATRIX_PLATFORM } from './matrixBridgeConfig.js'

/**
 * Bridge v2 privacy endpoints, mounted under /bridge/v2/privacy (Discord) and
 * /bridge/v2/matrix/privacy behind the bridge's middleware (bot token, rate limit, the server).
 * `:id` is a user id of the platform. Thin over the bridge_privacy_* RPCs (20261112600001).
 *
 *   GET    /optouts        {version, remote_user_ids}
 *   GET    /optouts/:id    {opted_out, since, source}
 *   PUT    /optouts/:id    opt out
 *   DELETE /optouts/:id    opt in; a manager's or admin's removal stays
 *   POST   /erase          {remote_user_id} (Discord) or {user_id} (Matrix): opt out, then delete the
 *                          user's relayed and imported rows. 202 {opted_out, erased, more}; with more
 *                          the rest is deleted in the background. 429 erase_recent inside
 *                          ERASE_COOLDOWN_MS of the last request for the same user.
 */

type PrivacyRequest = BotRequest & { bridge?: BridgeRow }

export interface PrivacyScope {
  platform: string
  /** Shape of the platform's user ids (bridge_privacy_check_subject). */
  validId: (id: unknown) => id is string
  /** Body field of POST /erase that names the user. */
  eraseField: string
  serverId: (req: Request) => string
}

const DISCORD_PRIVACY: PrivacyScope = {
  platform: DISCORD_PLATFORM,
  validId: (id): id is string => typeof id === 'string' && SNOWFLAKE.test(id),
  eraseField: 'remote_user_id',
  serverId: (req) => (req as PrivacyRequest).bridge!.server_id,
}

// Platforms whose unfinished erases are resumed.
const RESUMED_PLATFORMS: readonly string[] = [DISCORD_PLATFORM, MATRIX_PLATFORM]

interface EraseSubject {
  serverId: string
  platform: string
  remoteUserId: string
}

const subjectKey = (subject: EraseSubject) => `${subject.platform}:${subject.serverId}:${subject.remoteUserId}`

// Rows per bridge_privacy_erase call.
const ERASE_BATCH = 200
// Batches one background erase runs: 2,000,000 rows.
const ERASE_MAX_BATCHES = 10_000
const ERASE_PAUSE_MS = 50
// A failed batch (a lock or statement timeout, a deadlock) is tried again after these pauses.
const ERASE_RETRY_MS = [1_000, 5_000, 30_000]
// One erase per user and server a minute: each starts a background loop of batches.
export const ERASE_COOLDOWN_MS = 60_000
const ERASE_TRACKED_MAX = 10_000

interface EraseResult {
  opted_out?: boolean
  erased?: number
  more?: boolean
}

/** subjectKey -> when the last erase was accepted; true while its tail runs. */
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

/** The batches after the first: bridge_privacy_erase_tail stops once the user opted in again. */
async function eraseTailBatch({ serverId, platform, remoteUserId }: EraseSubject) {
  return supabase.rpc('bridge_privacy_erase_tail', {
    p_server_id: serverId,
    p_platform: platform,
    p_remote_user_id: remoteUserId,
    p_limit: ERASE_BATCH,
  })
}

async function eraseBatch({ serverId, platform, remoteUserId }: EraseSubject) {
  return supabase.rpc('bridge_privacy_erase', {
    p_server_id: serverId,
    p_platform: platform,
    p_remote_user_id: remoteUserId,
    p_limit: ERASE_BATCH,
  })
}

/** Repeats the erase until nothing is left. One loop per user and server. */
async function eraseRest(subject: EraseSubject): Promise<void> {
  const key = subjectKey(subject)
  const { serverId } = subject
  if (eraseRunning.has(key)) return
  eraseRunning.add(key)
  try {
    for (let i = 0; i < ERASE_MAX_BATCHES; i++) {
      await new Promise((resolve) => setTimeout(resolve, ERASE_PAUSE_MS))
      let { data, error } = await eraseTailBatch(subject)
      for (const wait of ERASE_RETRY_MS) {
        if (!error) break
        console.warn(`bridge_privacy_erase_tail for server ${serverId} failed, again in ${wait} ms:`, error.code, error.message)
        await new Promise((resolve) => setTimeout(resolve, wait))
        ;({ data, error } = await eraseTailBatch(subject))
      }
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

// Erases the database lists as unfinished (bridge_remote_optouts.erase_pending): a restart, a batch
// that failed every retry, or a manager's removal whose page closed left them.
const RESUME_EVERY_MS = 5 * 60_000
const RESUME_BATCH = 50

let resuming = false

/**
 * Finishes the erase of each listed user not already erasing here, one user at a time, so a restart
 * with many pending does not run their batches at once. Returns how many it ran; 0 while a pass runs.
 */
export async function resumePendingErases(): Promise<number> {
  if (resuming) return 0
  resuming = true
  try {
    const { data, error } = await supabase.rpc('bridge_privacy_pending', { p_limit: RESUME_BATCH })
    if (error) {
      console.error('bridge_privacy_pending failed:', error.code, error.message)
      return 0
    }
    const rows = (Array.isArray(data) ? data : []) as Array<{ server_id: string; platform: string; remote_user_id: string }>
    const ran = new Set<string>()
    for (const row of rows) {
      if (!RESUMED_PLATFORMS.includes(row.platform)) continue
      const subject = { serverId: row.server_id, platform: row.platform, remoteUserId: row.remote_user_id }
      const key = subjectKey(subject)
      if (ran.has(key) || eraseRunning.has(key)) continue
      ran.add(key)
      await eraseRest(subject)
    }
    return ran.size
  } finally {
    resuming = false
  }
}

/** resumePendingErases now and every RESUME_EVERY_MS; the returned function stops it. */
export function startEraseResume(): () => void {
  void resumePendingErases()
  const timer = setInterval(() => { void resumePendingErases() }, RESUME_EVERY_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** For tests: forgets every erase seen. */
export function resetEraseCooldown() {
  eraseSeen.clear()
  eraseRunning.clear()
}

/** `guard` goes on each route, not on the mount: the rate limiter buckets by `req.route`. */
export function createBridgePrivacyRouter(guard: RequestHandler[] = [], scope: PrivacyScope = DISCORD_PRIVACY): Router {
  const router = Router()
  const { platform, serverId } = scope

  router.param('id', (_req, res, next, id) => {
    if (!scope.validId(id)) return res.status(400).json({ code: 'invalid_remote_user' })
    next()
  })

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
      p_platform: platform,
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
      p_platform: platform,
      p_remote_user_id: req.params.id,
    })
    if (error) return failed(res, 'bridge_privacy_status', error)
    res.json(data)
  }))

  const setOptout = (optedOut: boolean) => handler(async (req, res) => {
    const { data, error } = await supabase.rpc('bridge_privacy_set_optout', {
      p_server_id: serverId(req),
      p_platform: platform,
      p_remote_user_id: req.params.id,
      p_opted_out: optedOut,
    })
    if (error) return failed(res, 'bridge_privacy_set_optout', error)
    res.json(data)
  })
  router.put('/optouts/:id', ...guard, setOptout(true))
  router.delete('/optouts/:id', ...guard, setOptout(false))

  router.post('/erase', ...guard, handler(async (req, res) => {
    const remoteUserId = (req.body as Record<string, unknown> | undefined)?.[scope.eraseField]
    if (!scope.validId(remoteUserId)) {
      return res.status(400).json({ code: 'invalid_remote_user' })
    }
    const subject: EraseSubject = { serverId: serverId(req), platform, remoteUserId }
    const key = subjectKey(subject)
    const now = Date.now()
    const last = eraseSeen.get(key)
    if (eraseRunning.has(key) || (last !== undefined && now - last < ERASE_COOLDOWN_MS)) {
      const wait = Math.max(1, Math.ceil((ERASE_COOLDOWN_MS - (now - (last ?? now))) / 1000))
      return res.set('Retry-After', String(wait)).status(429).json({ code: 'erase_recent', retry_after: wait })
    }
    remember(key, now)

    const { data, error } = await eraseBatch(subject)
    if (error) {
      eraseSeen.delete(key)
      return failed(res, 'bridge_privacy_erase', error)
    }
    const result = (data ?? {}) as EraseResult
    if (result.more === true) {
      eraseRest(subject).catch((err) => console.error('bridge erase tail failed:', err))
    }
    res.status(202).json({ opted_out: true, erased: result.erased ?? 0, more: result.more === true })
  }))

  return router
}
