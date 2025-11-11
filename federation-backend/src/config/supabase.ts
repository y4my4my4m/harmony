import { createClient, SupabaseClient } from '@supabase/supabase-js';
import config from './index.js';

let supabaseInstance: SupabaseClient | null = null;

/**
 * Get Supabase client instance (singleton)
 */
export const getSupabaseClient = (): SupabaseClient => {
  if (!supabaseInstance) {
    supabaseInstance = createClient(
      config.SUPABASE_URL,
      config.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );
  }
  return supabaseInstance;
};

/**
 * Get Supabase client with user context (for RLS)
 */
export const getSupabaseClientWithAuth = (accessToken: string): SupabaseClient => {
  return createClient(
    config.SUPABASE_URL,
    config.SUPABASE_ANON_KEY,
    {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    }
  );
};

export default getSupabaseClient;

