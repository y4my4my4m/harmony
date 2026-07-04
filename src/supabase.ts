// src/supabase.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getStoredInstance, isTauriRuntime } from '@/services/instanceConfig';

// Native clients select their instance at runtime; web builds are
// instance-bound via build-time env.
const storedInstance = getStoredInstance();
const supabaseUrl: string =
  storedInstance?.supabaseUrl ||
  import.meta.env.VITE_SUPABASE_URL ||
  // native client before instance selection: the picker gates the UI and
  // reloads once an instance is chosen, so this client is never used
  'https://instance-not-selected.invalid';
const supabaseAnonKey: string =
  storedInstance?.supabaseAnonKey ||
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  'instance-not-selected';

if (supabaseUrl === 'https://instance-not-selected.invalid' && !isTauriRuntime()) {
  throw new Error(
    'Missing Supabase configuration. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.'
  );
}

// "Remember me" - session persistence preference
//
// The Supabase client persists its session token via a `Storage`-shaped
// adapter. The default adapter writes to `localStorage`, which means
// sessions survive browser restarts unconditionally - there's no way for
// the user to opt into "session-only" persistence (where closing the
// browser logs them out).
//
// We support that opt-out via a small adapter that switches between
// `localStorage` and `sessionStorage` based on a sticky preference, also
// stored in localStorage so it survives page loads. The login form sets
// the preference before calling `signInWithPassword` / `signInWithOAuth`,
// so the freshly-issued token lands in the right store.
//
// Defaults to `true` (remember) so users upgrading from the pre-fix
// hardcoded `persistSession: true` behavior don't get silently logged
// out on first refresh after deploy.

const REMEMBER_ME_STORAGE_KEY = 'harmony.auth.remember_me';

function localStore(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function sessionStore(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Persist the "remember me" preference. Call this BEFORE the auth call
 * (signInWithPassword / signInWithOAuth) so the freshly-issued session
 * token is written to the correct underlying store. The adapter below
 * reads this flag every time Supabase calls `getItem`/`setItem`.
 */
export function setRememberMe(remember: boolean): void {
  const ls = localStore();
  if (!ls) return;
  try {
    ls.setItem(REMEMBER_ME_STORAGE_KEY, remember ? 'true' : 'false');
  } catch {
    // localStorage write blocked (private mode quota, hardened browsers).
    // The preference falls back to the default (remember) on next read,
    // which is the safest behavior - at worst the user's "session-only"
    // wish is ignored, but we never accidentally log them out.
  }
}

/**
 * Read the current "remember me" preference. Defaults to `true` when
 * unset (first-time user) or when localStorage is unavailable, matching
 * the pre-fix hardcoded behavior.
 */
export function getRememberMe(): boolean {
  const ls = localStore();
  if (!ls) return true;
  try {
    const val = ls.getItem(REMEMBER_ME_STORAGE_KEY);
    if (val === null) return true;
    return val === 'true';
  } catch {
    return true;
  }
}

/**
 * Storage adapter that delegates to either `localStorage` (when remember
 * is on) or `sessionStorage` (when remember is off).
 *
 * Three behaviors worth calling out:
 *
 * 1. `getItem` checks the *active* store first, then falls back to the
 *    inactive one. This makes the preference toggle non-destructive: a
 *    user who had remember-me checked, was logged in, then unchecks and
 *    refreshes WITHOUT logging in again will still find their session
 *    (it's in localStorage, the now-inactive store). This is intentional
 *    - the preference takes effect on the NEXT login, not retroactively.
 *
 * 2. `setItem` writes to the active store and explicitly removes the
 *    key from the inactive store. Without this clean-up, a token would
 *    end up in BOTH stores - fine in steady state, but if the user
 *    later flips remember-me, the fallback in (1) would let the stale
 *    copy keep them "logged in" past their intent.
 *
 * 3. `removeItem` (called by `signOut`) clears both stores so logging
 *    out is total regardless of the current preference.
 *
 * All store accesses are wrapped in try/catch - `localStorage` /
 * `sessionStorage` can throw `SecurityError` / `QuotaExceededError` in
 * private-browsing modes and locked-down enterprise browsers.
 */
// Type matches Supabase's `SupportedStorage` (Pick<Storage, get/set/remove>).
// We don't import that type to keep `@supabase/auth-js` out of our public
// surface, but the structural compatibility is guaranteed - `auth.storage`
// only ever invokes these three methods.
const sessionAwareStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
  getItem(key: string): string | null {
    if (typeof window === 'undefined') return null;
    const remember = getRememberMe();
    const primary = remember ? localStore() : sessionStore();
    const fallback = remember ? sessionStore() : localStore();
    try {
      const v = primary?.getItem(key) ?? null;
      if (v !== null) return v;
    } catch { /* primary unavailable, try fallback */ }
    try {
      return fallback?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },

  setItem(key: string, value: string): void {
    if (typeof window === 'undefined') return;
    const remember = getRememberMe();
    const primary = remember ? localStore() : sessionStore();
    const other = remember ? sessionStore() : localStore();
    try { primary?.setItem(key, value); } catch { /* storage write may fail */ }
    try { other?.removeItem(key); } catch { /* best-effort cleanup */ }
  },

  removeItem(key: string): void {
    if (typeof window === 'undefined') return;
    try { localStore()?.removeItem(key); } catch { /* best-effort */ }
    try { sessionStore()?.removeItem(key); } catch { /* best-effort */ }
  },
};

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    storage: sessionAwareStorage,
  },
  // Supabase handles realtime reconnection automatically
  // No need for custom health check logic
});

// Simple exports for backward compatibility
// These functions are kept minimal - Supabase handles connection management

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
