// src/supabase.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getStoredInstance, isTauriRuntime } from '@/services/instanceConfig';

// native clients pick their instance at runtime; web builds use build-time env
const storedInstance = getStoredInstance();
const supabaseUrl: string =
  storedInstance?.supabaseUrl ||
  import.meta.env.VITE_SUPABASE_URL ||
  // placeholder before instance selection; picker gates the UI so it's never used
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

// "Remember me" - session persistence preference.
//
// Supabase's default storage adapter writes the session token to
// `localStorage`, so sessions survive browser restarts unconditionally.
// The adapter below switches between `localStorage` and `sessionStorage`
// on a sticky preference (itself kept in localStorage). The login form
// sets the preference before `signInWithPassword` / `signInWithOAuth` so
// the freshly-issued token lands in the right store.
//
// Defaults to `true` (remember), matching the previous hardcoded
// `persistSession: true` behavior.

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
 * Persist the "remember me" preference. Call BEFORE the auth call
 * (signInWithPassword / signInWithOAuth) so the freshly-issued session
 * token is written to the correct store. The adapter reads this flag on
 * every `getItem`/`setItem`.
 */
export function setRememberMe(remember: boolean): void {
  const ls = localStore();
  if (!ls) return;
  try {
    ls.setItem(REMEMBER_ME_STORAGE_KEY, remember ? 'true' : 'false');
  } catch {
    // localStorage write blocked (private mode quota, hardened browsers).
    // Next read falls back to the default (remember): "session-only" is
    // ignored rather than logging the user out.
  }
}

/**
 * Read the "remember me" preference. Defaults to `true` when unset or
 * when localStorage is unavailable.
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
 * Storage adapter delegating to `localStorage` (remember on) or
 * `sessionStorage` (remember off).
 *
 * 1. `getItem` reads the active store, then falls back to the inactive
 *    one. The preference therefore takes effect on the NEXT login, not
 *    retroactively: toggling it off without re-authenticating keeps the
 *    existing localStorage session.
 *
 * 2. `setItem` writes the active store and removes the key from the
 *    inactive one. Without the removal a token sits in both stores, and
 *    the fallback in (1) would resurrect the stale copy after a toggle.
 *
 * 3. `removeItem` (called by `signOut`) clears both stores.
 *
 * All accesses are wrapped in try/catch: `localStorage` /
 * `sessionStorage` throw `SecurityError` / `QuotaExceededError` in
 * private-browsing and locked-down enterprise browsers.
 */
// Structurally matches Supabase's `SupportedStorage`
// (Pick<Storage, get/set/remove>). The type is not imported, to keep
// `@supabase/auth-js` off the public surface; `auth.storage` invokes only
// these three methods.
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
  // Realtime reconnection is handled by the client; no custom health check.
});

// Retained for backward compatibility. Connection management lives in the
// Supabase client.

/** Liveness probe: refreshes the auth session. */
export async function ensureFreshConnection(): Promise<boolean> {
  try {
    await supabase.auth.getSession();
    return true;
  } catch {
    return false;
  }
}

// Legacy no-op exports.
export function markQuerySuccess(): void {}
export function shouldCheckConnection(): boolean { return false; }
