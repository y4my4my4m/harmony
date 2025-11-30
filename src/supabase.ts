// src/supabase.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl: string = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey: string = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
  // Supabase handles realtime reconnection automatically
  // No need for custom health check logic
});

// ============================================================================
// Simple exports for backward compatibility
// These functions are kept minimal - Supabase handles connection management
// ============================================================================

/**
 * Check if connection is healthy (lightweight)
 * Just refreshes auth session - Supabase handles the rest
 */
export async function ensureFreshConnection(): Promise<boolean> {
  try {
    await supabase.auth.getSession();
    return true;
  } catch {
    return false;
  }
}

// Legacy exports - kept for compatibility but do nothing
export function markQuerySuccess(): void {}
export function shouldCheckConnection(): boolean { return false; }
