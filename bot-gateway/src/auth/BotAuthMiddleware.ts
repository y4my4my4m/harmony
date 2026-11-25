import { Request, Response, NextFunction } from 'express'
import { MemoryStore, type Options } from 'express-rate-limit'
import { supabase, config } from '../config/supabase.js'
import * as crypto from 'crypto'

export interface BotRequest extends Request {
  bot?: {
    id: string
    username: string
    scopes: string[]
  }
}

export async function botAuthMiddleware(
  req: BotRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const authHeader = req.headers.authorization
    
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing Authorization header' })
    }
    
    // Expected format: "Bot TOKEN"
    const parts = authHeader.split(' ')
    if (parts.length !== 2 || parts[0] !== 'Bot') {
      return res.status(401).json({ error: 'Invalid Authorization header format. Expected: Bot TOKEN' })
    }
    
    const token = parts[1]
    
    // Hash token for lookup
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    
    const { data: verification, error } = await supabase.rpc('verify_bot_token', {
      p_token_hash: tokenHash
    })

    // A lookup that never ran says nothing about the credential. 401 here would
    // report a broken RPC as a bad token and hide the SQLSTATE.
    if (error) {
      console.error('verify_bot_token failed:', error.code, error.message, error.details)
      return res.status(503).json({ error: 'Token verification unavailable' })
    }

    if (!verification || !verification.valid) {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }

    req.bot = {
      id: verification.bot_id,
      username: verification.username,
      scopes: verification.scopes || []
    }

    next()
  } catch (error) {
    console.error('Auth middleware error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

// Requests no route matches share one bucket per bot. Their paths are caller-chosen; keying on
// them would mint a bucket, and a bot_rate_limits row, per request.
export const UNMATCHED_BUCKET = 'unmatched'

// Every /interactions/ route of a bot shares one bucket of 50 requests per 5 s, counted apart
// from the bot's 'overall' bucket: each interaction already caps at one reply and 10 follow-ups.
export const INTERACTION_BUCKET = 'interactions'
export const INTERACTION_LIMIT = 50
export const INTERACTION_WINDOW_SECONDS = 5

// A Matrix bridge reads bridge-check twice per relayed message: at 4 times a route's limit the checks
// admit, in a channel, as many messages each way as POST messages does.
export const BRIDGE_CHECK_FACTOR = 4

// Route parameters that name the resource a bucket is per, as Discord's major parameters.
const MAJOR_PARAMS = new Set(['channelId', 'serverId', 'guildId'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// History import routes count per method and per job (`:id`): a bridge reads and patches its job
// twice for every thread it imports.
const PER_JOB_MOUNT = '/bridge/v2/imports'

/**
 * Bucket for a request: the matched route pattern with its major parameters filled in, e.g.
 * /api/v1/channels/<channel uuid>/messages. Express matches routes case-insensitively and with an
 * optional trailing slash, and the query string is not part of the route, so every spelling of
 * one route on one resource shares a bucket. baseUrl is the URL's own spelling of the mount path
 * and is lowercased; a major parameter that is not a UUID is one shared `:invalid` value.
 * Interaction routes answer INTERACTION_BUCKET. History import routes are prefixed with the
 * method (HEAD as GET) and fill `:id` as a major parameter.
 */
export function rateLimitBucket(req: Request): string {
  const routePath = req.route?.path
  if (typeof routePath !== 'string') return UNMATCHED_BUCKET
  if (routePath.startsWith('/interactions/')) return INTERACTION_BUCKET
  const base = req.baseUrl.toLowerCase()
  const perJob = base.endsWith(PER_JOB_MOUNT)
  const filled = routePath.replace(/:(\w+)/g, (param: string, name: string) => {
    if (!MAJOR_PARAMS.has(name) && !(perJob && name === 'id')) return param
    const value = req.params?.[name]
    return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : ':invalid'
  })
  if (!perJob) return `${base}${filled}`
  return `${req.method === 'HEAD' ? 'GET' : req.method} ${base}${filled}`
}

/**
 * Per-route rate limit. Runs after botAuthMiddleware and after route matching: as a route
 * handler, or as router middleware behind every route for requests none matched.
 */
export async function botRateLimit(req: BotRequest, res: Response, next: NextFunction) {
  if (!req.bot) {
    return res.status(401).json({ error: 'Missing Authorization header' })
  }

  const bucket = rateLimitBucket(req)
  const retryAfter = bucket === INTERACTION_BUCKET
    ? await checkInteractionLimit(req.bot.id)
    : await checkRateLimit(req.bot.id, bucket)
  if (retryAfter > 0) {
    res.setHeader('Retry-After', String(retryAfter))
    return res.status(429).json({
      error: 'Rate limit exceeded',
      retry_after: retryAfter
    })
  }

  next()
}

// Route buckets, counted here while the rate-limit RPC fails.
const localCounts = new MemoryStore()
localCounts.init({ windowMs: config.rateLimit.windowMs } as Options)

/**
 * A bot's requests per minute, all buckets together, while the rate-limit RPC fails. The database's
 * overall ceiling is an antispam setting the gateway cannot read then; 3000 is the default of
 * bridge_requests_per_minute, the highest default, so no bot within its default is refused. Keyed
 * by bot alone: buckets are minted per channel id before any permission check, and naming fresh
 * ids must not lift the count.
 */
export const LOCAL_OVERALL_PER_MINUTE = 3000
const localOverallCounts = new MemoryStore()
localOverallCounts.init({ windowMs: 60_000 } as Options)

/**
 * Seconds to wait while the rate-limit RPC fails: the route bucket, then the bot's overall count,
 * as bot_rate_limit_check. The overall limit never reads below `floor` per window, the route limit
 * unless the route has more of its own.
 */
export async function localRateLimitWait(
  botId: string,
  bucket: string,
  maxRequests: number,
  windowSeconds: number,
  overallPerMinute = LOCAL_OVERALL_PER_MINUTE,
  floor = maxRequests,
): Promise<number> {
  const route = await countLocally(localCounts, botId, bucket, maxRequests, windowSeconds)
  const overall = await countLocally(
    localOverallCounts, botId, 'overall',
    Math.max(overallPerMinute, Math.ceil((floor * 60) / windowSeconds)), 60,
  )
  return Math.max(route, overall)
}

const localInteractionCounts = new MemoryStore()
localInteractionCounts.init({ windowMs: INTERACTION_WINDOW_SECONDS * 1000 } as Options)

async function countLocally(
  store: MemoryStore,
  botId: string,
  bucket: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<number> {
  const { totalHits, resetTime } = await store.increment(`${botId}:${bucket}`)
  if (totalHits <= maxRequests) return 0
  return resetTime ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000)) : windowSeconds
}

/**
 * INTERACTION_BUCKET through bot_rate_limit_take, which counts no 'overall' request. Seconds to
 * wait; 0 admits. An RPC error counts in this process, as checkRateLimit.
 */
async function checkInteractionLimit(botId: string): Promise<number> {
  const local = () =>
    countLocally(localInteractionCounts, botId, INTERACTION_BUCKET, INTERACTION_LIMIT, INTERACTION_WINDOW_SECONDS)
  try {
    const { data, error } = await supabase.rpc('bot_rate_limit_take', {
      p_bot_id: botId,
      p_bucket: INTERACTION_BUCKET,
      p_limit: INTERACTION_LIMIT,
      p_window_seconds: INTERACTION_WINDOW_SECONDS,
    })
    if (error) {
      console.error('Interaction rate limit RPC error:', error)
      return local()
    }
    if (typeof data === 'number') return data
    console.error('Interaction rate limit RPC answered no number:', JSON.stringify(data))
    return local()
  } catch (error) {
    console.error('Interaction rate limit check error:', error)
    return local()
  }
}

/**
 * Seconds the request must wait before a retry; 0 admits it.
 *
 * check_and_increment_bot_rate_limit counts the route bucket and the bot's overall bucket in one
 * call. A database older than migration 20261109200001 answers a boolean, true for a full window.
 * bot_rate_limit_check does for a route with more than the configured limit, which the overall
 * ceiling does not rise to.
 *
 * Window and limit come from config.rateLimit (RATE_LIMIT_WINDOW_MS,
 * RATE_LIMIT_MAX_REQUESTS). Window is passed in seconds, floored at 1.
 *
 * An RPC error or an answer of another type counts in this process (localRateLimitWait), so a
 * limiter fault neither stops the bot API nor removes the limits. 5xx here would lose relayed
 * messages: the bridge retries no POST on 5xx.
 */
async function checkRateLimit(botId: string, bucket: string): Promise<number> {
  const windowSeconds = Math.max(1, Math.floor(config.rateLimit.windowMs / 1000))
  const floor = config.rateLimit.maxRequests
  const maxRequests = bucket.endsWith('/bridge-check') ? floor * BRIDGE_CHECK_FACTOR : floor
  const local = () => localRateLimitWait(botId, bucket, maxRequests, windowSeconds, LOCAL_OVERALL_PER_MINUTE, floor)

  try {
    const { data, error } = maxRequests === floor
      ? await supabase.rpc('check_and_increment_bot_rate_limit', {
        p_bot_id: botId,
        p_bucket: bucket,
        p_limit: maxRequests,
        p_window_seconds: windowSeconds,
      })
      : await supabase.rpc('bot_rate_limit_check', {
        p_bot_id: botId,
        p_bucket: bucket,
        p_limit: maxRequests,
        p_window_seconds: windowSeconds,
        p_floor: floor,
      })

    if (error) {
      console.error('Rate limit RPC error:', error)
      return local()
    }

    if (typeof data === 'number') return data
    if (typeof data === 'boolean') return data ? windowSeconds : 0
    console.error('Rate limit RPC answered neither a number nor a boolean:', JSON.stringify(data))
    return local()
  } catch (error) {
    console.error('Rate limit check error:', error)
    return local()
  }
}
