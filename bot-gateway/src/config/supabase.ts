import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'

dotenv.config()

const supabaseUrlEnv = process.env.SUPABASE_URL
const serviceKeyEnv = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrlEnv || !serviceKeyEnv) {
  throw new Error('Missing Supabase configuration. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env')
}

export const supabaseUrl: string = supabaseUrlEnv
export const supabaseServiceKey: string = serviceKeyEnv

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

/** A client that runs as the user behind `jwt` (RLS and auth.uid() apply), for checks made with the caller's identity. */
export function createUserClient(jwt: string) {
  return createClient(supabaseUrl as string, supabaseServiceKey as string, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { apikey: supabaseServiceKey as string, Authorization: `Bearer ${jwt}` } },
  })
}

/** Seconds the GoTrue settings are cached. */
const AUTH_SETTINGS_TTL_MS = 60_000
let autoconfirmCache: { value: boolean; at: number } | null = null

/**
 * GoTrue's `mailer_autoconfirm` from its public settings endpoint (cached 60 s); null when the
 * settings cannot be read, so callers can fail safe.
 */
export async function fetchMailerAutoconfirm(): Promise<boolean | null> {
  if (autoconfirmCache && Date.now() - autoconfirmCache.at < AUTH_SETTINGS_TTL_MS) return autoconfirmCache.value
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: supabaseServiceKey as string },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { mailer_autoconfirm?: unknown }
    if (typeof body.mailer_autoconfirm !== 'boolean') return null
    autoconfirmCache = { value: body.mailer_autoconfirm, at: Date.now() }
    return body.mailer_autoconfirm
  } catch {
    return null
  }
}

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
  migration: {
    // ms between full syncs of one migrated server.
    syncMs: Math.max(60_000, parseInt(process.env.DISCORD_MIGRATION_SYNC_MS || '21600000') || 21_600_000),
    // ms between looks for a due server.
    pollMs: 30_000,
    // ms one server's pass may run before it is recorded and left for the next one.
    budgetMs: 120_000,
    batch: 100,
  },
  websocket: {
    heartbeatInterval: parseInt(process.env.WS_HEARTBEAT_INTERVAL || '30000'),
    // Identified connections one bot may hold in this process; at least 1.
    maxConnectionsPerBot: Math.max(1, parseInt(process.env.WS_MAX_CONNECTIONS_PER_BOT || '5') || 5),
    // ms from a socket opening to its successful IDENTIFY, clamped to 1-60 s.
    identifyTimeoutMs: Math.min(
      60_000,
      Math.max(1_000, parseInt(process.env.WS_IDENTIFY_TIMEOUT_MS || '30000') || 30_000),
    ),
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

