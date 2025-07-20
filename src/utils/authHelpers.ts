/**
 * Auth Helper Utilities (SIMPLIFIED)
 * 
 * You're absolutely right - if we trust the database RLS, we don't need 
 * extensive auth checks in the frontend. The database handles auth via RLS policies.
 */

import { userDataService } from '@/services/userDataService'
import { useAuthStore } from '@/stores/auth'

/**
 * Check if user is authenticated (simple cache-based check)
 * Only for UI state, not security - database RLS handles security
 */
export function isAuthenticated(): boolean {
  try {
    // Quick check from cached data
    const currentUser = userDataService.getCurrentUser()
    if (currentUser?.auth_user_id) {
      return true
    }

    // Fallback to auth store
    const authStore = useAuthStore()
    return !!authStore.session?.user?.id
  } catch {
    return false
  }
}

/**
 * Get current user ID for UI purposes only
 * Database RLS handles actual security
 */
export function getCurrentUserId(): string | null {
  try {
    // Try userDataService first
    const currentUser = userDataService.getCurrentUser()
    if (currentUser?.auth_user_id) {
      return currentUser.auth_user_id
    }

    // Fallback to auth store
    const authStore = useAuthStore()
    return authStore.session?.user?.id || null
  } catch {
    return null
  }
}

/**
 * Get current user profile ID for UI purposes only
 * Database RLS handles actual security
 */
export function getCurrentProfileId(): string | null {
  try {
    const currentUser = userDataService.getCurrentUser()
    return currentUser?.id || null
  } catch {
    return null
  }
}