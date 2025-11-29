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
});

// ============================================================================
// Connection Health Tracking and Recovery
// ============================================================================

let lastSuccessfulQuery = Date.now();
let isRecoveryInProgress = false;

/**
 * Mark that a successful query was made
 */
export function markQuerySuccess(): void {
  lastSuccessfulQuery = Date.now();
}

/**
 * Check if we should verify connection before an operation
 * Only returns true if it's been a while since last success
 */
export function shouldCheckConnection(): boolean {
  const timeSinceSuccess = Date.now() - lastSuccessfulQuery;
  // Check if more than 2 minutes since last successful query
  return timeSinceSuccess > 2 * 60 * 1000;
}

/**
 * Verify and fix connection health
 * 
 * This function:
 * 1. Refreshes the auth session
 * 2. Tests connection with a lightweight query
 * 3. Attempts realtime reconnection if needed
 * 
 * Returns true if connection is healthy, false otherwise
 */
export async function ensureFreshConnection(): Promise<boolean> {
  // Prevent multiple simultaneous recovery attempts
  if (isRecoveryInProgress) {
    // Wait a bit for the other recovery to complete
    await new Promise(resolve => setTimeout(resolve, 500));
    return true;
  }

  isRecoveryInProgress = true;
  
  try {
    // Step 1: Refresh auth session (fast, reliable)
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    
    if (sessionError) {
      console.warn('⚠️ Supabase: Session refresh failed:', sessionError.message);
      // Try to refresh the session explicitly
      await supabase.auth.refreshSession();
    }

    // Step 2: Test connection with a lightweight query (with short timeout)
    const testPromise = supabase
      .from('profiles')
      .select('id')
      .limit(1)
      .maybeSingle();
    
    const timeoutPromise = new Promise<{ error: Error }>((resolve) =>
      setTimeout(() => resolve({ error: new Error('Health check timeout') }), 5000)
    );

    const testResult = await Promise.race([testPromise, timeoutPromise]);
    
    if ('error' in testResult && testResult.error) {
      console.warn('⚠️ Supabase: Connection test failed:', testResult.error);
      
      // Step 3: Try to reconnect realtime if connection seems broken
      try {
        await reconnectRealtime();
      } catch (realtimeError) {
        console.warn('⚠️ Supabase: Realtime reconnect failed:', realtimeError);
      }
      
      isRecoveryInProgress = false;
      return false;
    }

    // Connection is healthy
    markQuerySuccess();
    isRecoveryInProgress = false;
    return true;
    
  } catch (error) {
    console.warn('⚠️ Supabase: Connection health check error:', error);
    isRecoveryInProgress = false;
    // Return true anyway to allow the operation to attempt
    // Better to try and fail than to block
    return true;
  }
}

/**
 * Attempt to reconnect the Supabase realtime connection
 * This helps recover from stale websocket connections
 */
async function reconnectRealtime(): Promise<void> {
  try {
    const realtimeClient = (supabase as any).realtime;
    
    if (realtimeClient) {
      // Disconnect and reconnect the realtime client
      if (typeof realtimeClient.disconnect === 'function') {
        await realtimeClient.disconnect();
      }
      
      // Small delay before reconnecting
      await new Promise(resolve => setTimeout(resolve, 100));
      
      if (typeof realtimeClient.connect === 'function') {
        await realtimeClient.connect();
      }
      
      console.log('✅ Supabase: Realtime reconnected');
    }
  } catch (error) {
    // Realtime reconnect is best-effort, don't throw
    console.warn('⚠️ Supabase: Realtime reconnect error:', error);
  }
}

/**
 * Force a full reconnection of both REST and realtime
 * Use sparingly - this is a heavy operation
 */
export async function forceFullReconnect(): Promise<boolean> {
  console.log('🔄 Supabase: Forcing full reconnect...');
  
  try {
    // Refresh auth session
    await supabase.auth.refreshSession();
    
    // Reconnect realtime
    await reconnectRealtime();
    
    // Test connection
    const { error } = await supabase.from('profiles').select('id').limit(1).maybeSingle();
    
    if (error) {
      console.error('❌ Supabase: Full reconnect failed:', error);
      return false;
    }
    
    markQuerySuccess();
    console.log('✅ Supabase: Full reconnect successful');
    return true;
    
  } catch (error) {
    console.error('❌ Supabase: Full reconnect error:', error);
    return false;
  }
}
