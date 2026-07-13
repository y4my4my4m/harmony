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
 * Atomic rate-limit check + increment via `check_and_increment_bot_rate_limit`
 * (UPSERT + window-reset + limit check under one row lock). Fixes a
 * read-modify-write race (BUGS.md M37) where concurrent requests could both
 * pass the threshold before either wrote back, letting through ~2x burst.
 * Fails open (returns false) on RPC error.
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

