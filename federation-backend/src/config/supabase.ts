import { AuthError, createClient, SupabaseClient } from '@supabase/supabase-js';
import { meetsAssurance } from '../utils/sessionAssurance.js';
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
 *
 * auth.getUser() answers no user for a token below the account's assurance level
 * (utils/sessionAssurance.ts), so every route that authenticates through this client
 * refuses a password-only session of a 2FA account.
 */
export const getSupabaseClientWithAuth = (accessToken: string): SupabaseClient => {
  const client = createClient(
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
  const getUser = client.auth.getUser.bind(client.auth);
  client.auth.getUser = (async (jwt?: string) => {
    const result = await getUser(jwt);
    if (result.data.user && !meetsAssurance(result.data.user, jwt ?? accessToken)) {
      return {
        data: { user: null },
        error: new AuthError('insufficient_aal', 403, 'insufficient_aal'),
      };
    }
    return result;
  }) as typeof client.auth.getUser;
  return client;
};

export default getSupabaseClient;

