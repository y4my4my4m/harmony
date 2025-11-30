import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenvConfig();

// Environment validation schema
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('3001'),
  API_BASE_URL: z.string().url().default('http://localhost:3001'),
  
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
});

// Validate and export configuration
const parseEnv = () => {
  try {
    const parsed = envSchema.parse(process.env);
    
    // If PUBLIC_SUPABASE_URL is not set, use SUPABASE_URL
    if (!parsed.PUBLIC_SUPABASE_URL) {
      parsed.PUBLIC_SUPABASE_URL = parsed.SUPABASE_URL;
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

