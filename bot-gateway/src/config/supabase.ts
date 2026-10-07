import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'

dotenv.config()

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing Supabase configuration. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env')
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  },
  realtime: {
    params: {
      eventsPerSecond: 10
    },
    // For local Supabase, realtime goes through Kong
    headers: {
      apikey: supabaseServiceKey
    }
  },
  global: {
    headers: {
      apikey: supabaseServiceKey
    }
  }
})

/**
 * Express `trust proxy`. Default trusts loopback and private-network hops (nginx on the host or
 * in the compose network), so req.ip is the client address nginx forwarded. A number is a hop
 * count; 'true' and 'false' are booleans.
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = (raw ?? '').trim()
  if (!value) return 'loopback, linklocal, uniquelocal'
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^\d+$/.test(value)) return parseInt(value, 10)
  return value
}

export const config = {
  supabaseUrl,
  port: parseInt(process.env.PORT || '3002'),
  nodeEnv: process.env.NODE_ENV || 'development',
  instanceDomain: process.env.INSTANCE_DOMAIN || 'localhost:3000',
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  bridge: {
    // Unset values are empty strings: response URLs never fall back to a localhost default.
    instanceDomain: (process.env.INSTANCE_DOMAIN || '').trim(),
    publicUrl: (process.env.PUBLIC_URL || '').trim(),
    // GET /bridge/v2/hosted answers 404 while this is shorter than 32 characters.
    hostSecret: process.env.BRIDGE_HOST_SECRET || '',
    // ms between discord_bridges.updated_at polls, clamped to 1-60 s.
    configPollMs: Math.min(
      60_000,
      Math.max(1_000, parseInt(process.env.BRIDGE_CONFIG_POLL_MS || '5000') || 5_000),
    ),
  },
  websocket: {
    heartbeatInterval: parseInt(process.env.WS_HEARTBEAT_INTERVAL || '30000'),
    maxConnectionsPerBot: parseInt(process.env.WS_MAX_CONNECTIONS_PER_BOT || '5'),
    // ms between token/bot rechecks of open sessions, clamped to 1-60 s.
    revalidateIntervalMs: Math.min(
      60_000,
      Math.max(1_000, parseInt(process.env.WS_REVALIDATE_INTERVAL_MS || '30000') || 30_000),
    ),
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100')
  }
}

