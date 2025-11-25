import { Request, Response, NextFunction } from 'express'
import { supabase } from '../config/supabase.js'
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
    
    // Verify token
    const { data: verification, error } = await supabase.rpc('verify_bot_token', {
      p_token_hash: tokenHash
    }) as any
    
    if (error || !verification || !verification.valid) {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }
    
    // Attach bot info to request
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

async function checkRateLimit(botId: string, bucket: string): Promise<boolean> {
  try {
    // Get or create rate limit entry
    const { data: rateLimit } = await supabase
      .from('bot_rate_limits')
      .select('*')
      .eq('bot_id', botId)
      .eq('bucket', bucket)
      .single()
    
    const now = new Date()
    
    if (!rateLimit) {
      // Create new rate limit entry
      await supabase
        .from('bot_rate_limits')
        .insert({
          bot_id: botId,
          bucket,
          request_count: 1,
          window_start: now.toISOString(),
          resets_at: new Date(now.getTime() + 60000).toISOString()
        })
      return false
    }
    
    // Check if window has reset
    if (new Date(rateLimit.resets_at) < now) {
      // Reset window
      await supabase
        .from('bot_rate_limits')
        .update({
          request_count: 1,
          window_start: now.toISOString(),
          resets_at: new Date(now.getTime() + 60000).toISOString()
        })
        .eq('id', rateLimit.id)
      return false
    }
    
    // Check if rate limit exceeded
    if (rateLimit.request_count >= rateLimit.max_requests) {
      return true
    }
    
    // Increment request count
    await supabase
      .from('bot_rate_limits')
      .update({
        request_count: rateLimit.request_count + 1
      })
      .eq('id', rateLimit.id)
    
    return false
  } catch (error) {
    console.error('Rate limit check error:', error)
    return false // Allow request on error
  }
}

