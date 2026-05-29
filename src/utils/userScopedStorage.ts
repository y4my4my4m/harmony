/**
 * User-Scoped LocalStorage Service
 * 
 * Ensures localStorage data is isolated per user to prevent data leakage
 * when switching between accounts.
 * 
 * Usage:
 *   import { userStorage } from '@/utils/userScopedStorage'
 *   
 *   // Set current user (call on login)
 *   userStorage.setCurrentUser(userId)
 *   
 *   // Use like normal localStorage
 *   userStorage.setItem('key', 'value')
 *   const value = userStorage.getItem('key')
 *   
 *   // Clear current user's data (call on logout)
 *   userStorage.clearCurrentUser()
 */

import { debug } from './debug'

const STORAGE_PREFIX = 'harmony_'
const USER_ID_KEY = `${STORAGE_PREFIX}current_user_id`
const USER_DATA_PREFIX = `${STORAGE_PREFIX}user_`

/**
 * Resolve a stable identifier for *this* Harmony instance.
 *
 * Without this, two instances served from the same origin (e.g. several dev
 * builds on http://localhost:5173, or the Tauri desktop app pointed at
 * different backends) share one localStorage namespace, so the theme/appearance
 * config of one silently overwrites the others.
 *
 * Preference order (all build-time / synchronous, so this never races app init):
 *   1. VITE_DOMAIN / VITE_INSTANCE_DOMAIN - the federation domain
 *   2. VITE_SUPABASE_URL host - uniquely identifies the backend even when the
 *      frontend origin is shared
 *   3. window.location.host - last resort
 */
function resolveInstanceScope(): string {
  const env = (import.meta as any).env || {}
  let raw: string =
    env.VITE_DOMAIN ||
    env.VITE_INSTANCE_DOMAIN ||
    ''

  if (!raw && env.VITE_SUPABASE_URL) {
    try {
      raw = new URL(env.VITE_SUPABASE_URL).host
    } catch {
      /* malformed URL - fall through */
    }
  }

  if (!raw && typeof window !== 'undefined') {
    raw = window.location.host
  }

  const slug = String(raw || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'default'
}

const INSTANCE_SCOPE = resolveInstanceScope()
// Inserted into every key so per-user prefs are also per-instance.
const SCOPE_SEGMENT = `i_${INSTANCE_SCOPE}_`

class UserScopedStorage {
  private currentUserId: string | null = null
  private warnedKeys = new Set<string>() // Track which keys have been warned about

  /**
   * Initialize and set current user from stored session
   */
  initialize(): void {
    try {
      const storedUserId = localStorage.getItem(USER_ID_KEY)
      if (storedUserId) {
        this.currentUserId = storedUserId
        debug.log('🔐 User-scoped storage initialized for user:', storedUserId)
      }
    } catch (error) {
      debug.error('Failed to initialize user-scoped storage:', error)
    }
  }

  /**
   * Set the current user (call on login)
   * This will scope all subsequent localStorage operations to this user
   */
  setCurrentUser(userId: string): void {
    if (this.currentUserId === userId) {
      return // Already set
    }

    // Clear any old user's data if switching users
    if (this.currentUserId && this.currentUserId !== userId) {
      this.clearUserData(this.currentUserId)
    }

    this.currentUserId = userId
    try {
      localStorage.setItem(USER_ID_KEY, userId)
      debug.log('🔐 User-scoped storage set for user:', userId)
    } catch (error) {
      debug.error('Failed to set current user in storage:', error)
    }
  }

  /**
   * Get the current user ID
   */
  getCurrentUser(): string | null {
    return this.currentUserId
  }

  /**
   * Clear current user's data (call on logout)
   */
  clearCurrentUser(): void {
    if (this.currentUserId) {
      this.clearUserData(this.currentUserId)
      this.currentUserId = null
      try {
        localStorage.removeItem(USER_ID_KEY)
        debug.log('🔐 Cleared user-scoped storage for user')
      } catch (error) {
        debug.error('Failed to clear current user from storage:', error)
      }
    }
  }

  /**
   * Clear all data for a specific user
   */
  private clearUserData(userId: string): void {
    try {
      const keysToRemove: string[] = []
      
      // Find all keys that belong to this user, across every instance scope and
      // the legacy (non-scoped) layout. User IDs are UUIDs, so matching the
      // `user_{id}_` segment can't collide with anything else.
      const userSegment = `user_${userId}_`
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && key.startsWith(STORAGE_PREFIX) && key.includes(userSegment)) {
          keysToRemove.push(key)
        }
      }

      // Remove all user-specific keys
      keysToRemove.forEach(key => localStorage.removeItem(key))
      
      if (keysToRemove.length > 0) {
        debug.log(`🧹 Cleared ${keysToRemove.length} localStorage items for user ${userId}`)
      }
    } catch (error) {
      debug.error('Failed to clear user data:', error)
    }
  }

  /**
   * Get a user- AND instance-scoped key
   */
  private getUserKey(key: string): string {
    if (!this.currentUserId) {
      // If no user is set, use an instance-global key (still per-instance).
      // Only warn once per key to avoid excessive logs
      if (!this.warnedKeys.has(key)) {
        debug.warn('⚠️ Using instance-global localStorage key (no user set):', key)
        this.warnedKeys.add(key)
      }
      return `${STORAGE_PREFIX}${SCOPE_SEGMENT}${key}`
    }
    return `${STORAGE_PREFIX}${SCOPE_SEGMENT}user_${this.currentUserId}_${key}`
  }

  /**
   * Legacy (pre-instance-scoping) key for the same logical key. Used as a
   * read fallback so existing users keep their settings after this rolls out.
   */
  private getLegacyKey(key: string): string {
    if (!this.currentUserId) {
      return `${STORAGE_PREFIX}${key}`
    }
    return `${USER_DATA_PREFIX}${this.currentUserId}_${key}`
  }

  /**
   * Set an item in localStorage (user-scoped)
   */
  setItem(key: string, value: string): void {
    try {
      const userKey = this.getUserKey(key)
      localStorage.setItem(userKey, value)
    } catch (error) {
      debug.error(`Failed to set localStorage item ${key}:`, error)
      throw error
    }
  }

  /**
   * Get an item from localStorage (user-scoped)
   */
  getItem(key: string): string | null {
    try {
      const userKey = this.getUserKey(key)
      const value = localStorage.getItem(userKey)
      if (value !== null) return value

      // One-time migration: an existing user upgrading to instance-scoped keys
      // still has their data under the legacy (non-scoped) key. Adopt it so the
      // first read after deploy doesn't look like a reset.
      const legacyKey = this.getLegacyKey(key)
      if (legacyKey !== userKey) {
        const legacyValue = localStorage.getItem(legacyKey)
        if (legacyValue !== null) {
          try {
            localStorage.setItem(userKey, legacyValue)
            localStorage.removeItem(legacyKey)
          } catch {
            /* best-effort migration */
          }
          return legacyValue
        }
      }
      return null
    } catch (error) {
      debug.error(`Failed to get localStorage item ${key}:`, error)
      return null
    }
  }

  /**
   * Remove an item from localStorage (user-scoped)
   */
  removeItem(key: string): void {
    try {
      const userKey = this.getUserKey(key)
      localStorage.removeItem(userKey)
    } catch (error) {
      debug.error(`Failed to remove localStorage item ${key}:`, error)
    }
  }

  /**
   * Check if an item exists in localStorage (user-scoped)
   */
  hasItem(key: string): boolean {
    return this.getItem(key) !== null
  }

  /**
   * Get all keys for the current user
   */
  getUserKeys(): string[] {
    if (!this.currentUserId) {
      return []
    }

    const prefix = `${STORAGE_PREFIX}${SCOPE_SEGMENT}user_${this.currentUserId}_`
    const keys: string[] = []

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && key.startsWith(prefix)) {
          // Remove the prefix to get the original key
          keys.push(key.substring(prefix.length))
        }
      }
    } catch (error) {
      debug.error('Failed to get user keys:', error)
    }

    return keys
  }

  /**
   * Clear all data for all users (use with caution - for cleanup/debugging)
   */
  clearAll(): void {
    try {
      const keysToRemove: string[] = []
      
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && (key.startsWith(USER_DATA_PREFIX) || key === USER_ID_KEY)) {
          keysToRemove.push(key)
        }
      }

      keysToRemove.forEach(key => localStorage.removeItem(key))
      this.currentUserId = null
      
      debug.log(`🧹 Cleared all user-scoped storage (${keysToRemove.length} items)`)
    } catch (error) {
      debug.error('Failed to clear all user storage:', error)
    }
  }
}

// Export singleton instance
export const userStorage = new UserScopedStorage()

// Initialize on module load
if (typeof window !== 'undefined') {
  userStorage.initialize()
}

