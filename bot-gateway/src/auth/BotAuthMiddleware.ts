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
 * Returns true when the request must be refused with 429.
 *
 * check_and_increment_bot_rate_limit combines the upsert, window reset and
 * limit check into one statement under an exclusive row lock; a read-modify-write
 * here would let a burst through twice.
 *
 * Window and limit come from config.rateLimit (RATE_LIMIT_WINDOW_MS,
 * RATE_LIMIT_MAX_REQUESTS). Window is passed in seconds, floored at 1.
 *
 * Fails open: an RPC error admits the request rather than taking the bot API
 * offline.
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
    return false
  }
}

