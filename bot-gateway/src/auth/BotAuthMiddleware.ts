import { Request, Response, NextFunction } from 'express'
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
    }) as any
    
    if (error || !verification || !verification.valid) {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }
    
    req.bot = {
      id: verification.bot_id,
      username: verification.username,
      scopes: verification.scopes || []
    }
    
    // Check rate limits
    const isRateLimited = await checkRateLimit(verification.bot_id, req.path)
    if (isRateLimited) {
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        retry_after: 60 
      })
    }
    
    next()
  } catch (error) {
    console.error('Auth middleware error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Atomic rate-limit check + increment.
 *
 * Replaces the previous read-modify-write implementation which had a
 * documented race condition (BUGS.md M37): under burst load, two
 * concurrent requests could both observe `request_count = N`, both pass
 * the `< max_requests` threshold, then both write `N + 1`, letting
 * through ~2× the allowed burst. The new path delegates to the SQL
 * function `check_and_increment_bot_rate_limit`, which combines the
 * UPSERT, window-reset, and limit check into a single statement under
 * an exclusive row lock.
 *
 * Window and limit defaults come from `config.rateLimit`
 * (`RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_REQUESTS` env vars). Callers
 * with bucket-specific needs can pass overrides directly.
 *
 * Returns `true` if the request must be rejected with HTTP 429, `false`
 * if it may proceed. On any RPC error we fail open (return `false`) to
 * avoid a database hiccup taking down the bot API; this matches the
 * prior behaviour but the surface area is now much smaller.
 */
async function checkRateLimit(botId: string, bucket: string): Promise<boolean> {
  try {
    const windowSeconds = Math.max(1, Math.floor(config.rateLimit.windowMs / 1000))
    const maxRequests = config.rateLimit.maxRequests

    const { data, error } = await supabase.rpc('check_and_increment_bot_rate_limit', {
      p_bot_id: botId,
      p_bucket: bucket,
      p_limit: maxRequests,
      p_window_seconds: windowSeconds,
    })

    if (error) {
      console.error('Rate limit RPC error:', error)
      return false
    }

    return data === true
  } catch (error) {
    console.error('Rate limit check error:', error)
    return false // Allow request on error (matches pre-existing fail-open behaviour)
  }
}

