import { createClient, SupabaseClient } from '@supabase/supabase-js';
import config from './index.js';
import { logger } from '../utils/logger.js';

let supabaseInstance: SupabaseClient | null = null;

/**
 * Get Supabase client instance (singleton)
 */
export const getSupabaseClient = (): SupabaseClient => {
  if (!supabaseInstance) {
    const realtimeConfig: any = {
      params: {
        eventsPerSecond: 10,
        apikey: config.SUPABASE_SERVICE_ROLE_KEY,
      },
    };
    
    // Check for custom Realtime URL (for Docker environments)
    const realtimeUrl = process.env.SUPABASE_REALTIME_URL;
    if (realtimeUrl) {
      logger.info(`Using custom Realtime URL: ${realtimeUrl}`);
      realtimeConfig.url = realtimeUrl;
    }
    
    logger.debug(`Supabase URL: ${config.SUPABASE_URL}`);
    
    supabaseInstance = createClient(
      config.SUPABASE_URL,
      config.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
        realtime: realtimeConfig,
      }
    );
  }
  return supabaseInstance;
};

/**
 * Get Supabase client with user context (for RLS)
 *
 * One client per request. Outside a browser auth-js starts a 30 s refresh
 * interval per client when autoRefreshToken is set and never clears it; the
 * interval retains the client (about 8 KB each, measured on auth-js 2.99.3).
 * The token arrives in the Authorization header, so there is no session to
 * refresh or persist.
 */
export const getSupabaseClientWithAuth = (accessToken: string): SupabaseClient => {
  return createClient(
    config.SUPABASE_URL,
    config.SUPABASE_ANON_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    }
  );
};

export default getSupabaseClient;

