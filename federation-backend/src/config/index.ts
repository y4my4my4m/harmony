import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenvConfig();

// Environment validation schema
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('3001'),
  API_BASE_URL: z.string().url().default('http://localhost:3001'),

  // Software version, surfaced via NodeInfo, /health, and the federation User-Agent.
  // Bump this on each release (single source of truth for the federation backend).
  VERSION: z.string().default('1.1.0'),
  
  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string(),
  SUPABASE_SERVICE_ROLE_KEY: z.string(),
  // Public Supabase URL (for federation - can be different from internal URL)
  // If not set, defaults to SUPABASE_URL
  PUBLIC_SUPABASE_URL: z.string().url().optional(),
  
  // Instance
  INSTANCE_DOMAIN: z.string(),
  INSTANCE_NAME: z.string().default('Harmony'),
  INSTANCE_DESCRIPTION: z.string().default('A federated social platform'),
  
  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Optional direct, session-mode Postgres connection used ONLY for the
  // LISTEN/NOTIFY federation-jobs bridge (instant job pickup). Prefer a
  // dedicated least-privilege role (harmony_listener). DATABASE_URL is still
  // honoured for backward compatibility. Both are read via process.env in
  // worker.ts; declared here for documentation/visibility. When neither is
  // set the worker degrades to periodic-sweep pickup (no crash).
  FEDERATION_LISTENER_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  
  // Security
  JWT_SECRET: z.string().optional(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  
  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.string().transform(Number).default('900000'),
  RATE_LIMIT_MAX_REQUESTS: z.string().transform(Number).default('100'),
  
  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  
  // Web Push (VAPID) - Required for push notifications
  // Generate keys with: npx web-push generate-vapid-keys
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().email().optional(), // mailto: email for VAPID
  
  // LiveKit WebRTC Server
  // Generate keys with: openssl rand -hex 32
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  LIVEKIT_URL: z.string().optional(), // ws://localhost:7880 or wss://livekit.domain.com
  LIVEKIT_PUBLIC_URL: z.string().optional(), // Public URL for federated access
  
  // WebRTC Mode: 'sfu' | 'p2p' | 'hybrid' (sfu with p2p fallback)
  WEBRTC_MODE: z.enum(['sfu', 'p2p', 'hybrid']).default('hybrid'),
  
  // Allow federated voice/video calls
  ALLOW_FEDERATED_VOICE: z.string().transform(v => v === 'true').default('true'),
  
  // Enable BullMQ job queue processing (recommended for production)
  // When true, BullMQ handles federation jobs via LISTEN/NOTIFY bridge; when false, legacy DatabaseListener CDC is used
  USE_BULLMQ_QUEUE: z.preprocess(
    // Backward compat: accept USE_PGBOSS_QUEUE from env if USE_BULLMQ_QUEUE is not set
    (val) => val ?? process.env.USE_PGBOSS_QUEUE ?? 'true',
    z.string().transform(v => v === 'true')
  ),

  // Process mode: run HTTP server, queue workers, or both in one process
  //   'server'  - Express HTTP server only (ActivityPub inbox, WebFinger, health, etc.)
  //   'worker'  - Queue workers only (BullMQ, LISTEN/NOTIFY, delivery retries)
  //   'unified' - Both in one process (default, backward compatible)
  FEDERATION_MODE: z.enum(['server', 'worker', 'unified']).default('unified'),
  
  // Federation Security
  // When true (default), reject unsigned activities or activities with invalid signatures
  // Set to 'false' in development to allow testing with unsigned activities
  REQUIRE_VALID_SIGNATURES: z.string().transform(v => v !== 'false').default('true'),

  // Klipy GIF provider (replaces Tenor). Keys live ONLY on the backend so they
  // never reach the browser bundle. Two keys: one with ads enabled in the Klipy
  // dashboard, one without. The proxy picks per-request based on the viewer's
  // supporter tier, so the no-ads key is never exposed to clients.
  //   - KLIPY_API_KEY_ADS   : ad-enabled key (monetized, served to regular users)
  //   - KLIPY_API_KEY_NOADS : ad-free key (served to supporters whose tier removes ads)
  // If only one is set it is used for everyone. If neither is set, GIF search is disabled.
  KLIPY_API_KEY_ADS: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined),
    z.string().optional(),
  ),
  KLIPY_API_KEY_NOADS: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined),
    z.string().optional(),
  ),
  KLIPY_BASE_URL: z.string().url().default('https://api.klipy.com'),
  // Secret embedded in the AI-emoji generation callback URL so we can verify
  // inbound Klipy webhooks. Optional: when unset we derive a stable token from
  // the service-role key (always present), so this needs no extra config.
  AI_EMOJI_WEBHOOK_SECRET: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined),
    z.string().optional(),
  ),
});

// Validate and export configuration
const parseEnv = () => {
  try {
    const parsed = envSchema.parse(process.env);
    
    // If PUBLIC_SUPABASE_URL is not set, use SUPABASE_URL
    if (!parsed.PUBLIC_SUPABASE_URL) {
      parsed.PUBLIC_SUPABASE_URL = parsed.SUPABASE_URL;
    }

    // Signature verification is the only inbound authenticity check; every
    // inbox authz gate assumes activity.actor was matched against the signer.
    // Disabling it is a dev-only escape hatch - never allow it in production.
    if (parsed.NODE_ENV === 'production' && !parsed.REQUIRE_VALID_SIGNATURES) {
      console.error('❌ REQUIRE_VALID_SIGNATURES=false is not allowed with NODE_ENV=production:');
      console.error('   it disables all federation authentication (actor spoofing, forged deletes/blocks).');
      console.error('   Unset it, or set NODE_ENV=development.');
      process.exit(1);
    }

    return parsed;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Invalid environment variables:');
      error.errors.forEach((err) => {
        console.error(`  - ${err.path.join('.')}: ${err.message}`);
      });
      process.exit(1);
    }
    throw error;
  }
};

export const config = parseEnv();

export default config;

