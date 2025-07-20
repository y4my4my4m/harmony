/**
 * Auth Helper Utilities
 * 
 * Provides efficient auth user/profile access using cached data instead of 
 * making repeated database calls to supabase.auth.getUser()
 */

import { userDataService } from '@/services/userDataService'
import { useAuthStore } from '@/stores/auth'
import { supabase } from '@/supabase'

export interface AuthUser {
  id: string
  profileId: string
}

/**
 * Get current authenticated user's ID and profile ID efficiently
 * Uses cached data from userDataService first, fallback to auth store, 
 * then database only if absolutely necessary
 */
export async function getCurrentAuthUser(): Promise<AuthUser> {
  try {
    // FIRST: Try to get from userDataService cache (most efficient)
    const currentUser = userDataService.getCurrentUser()
    if (currentUser?.auth_user_id && currentUser?.id) {
      return {
        id: currentUser.auth_user_id,
        profileId: currentUser.id
      }
    }

    // SECOND: Try to get from auth store (still efficient)  
    const authStore = useAuthStore()
    if (authStore.session?.user?.id) {
      const authUserId = authStore.session.user.id
      
      // Try to get profile ID from userDataService by auth user ID
      const userData = userDataService.getUser(authUserId)
      if (userData?.id) {
        return {
          id: authUserId,
          profileId: userData.id
        }
      }
      
      // Fallback: Look up profile ID from database (only when cache miss)
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('id')
        .eq('auth_user_id', authUserId)
        .single()
        
      if (profile && !error) {
        return {
          id: authUserId,
          profileId: profile.id
        }
      }
    }

    // LAST RESORT: Database query (should rarely happen)
    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) {
      throw new Error('User not authenticated')
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single()
      
    if (profileError || !profile) {
      throw new Error('User profile not found')
    }

    return {
      id: user.id,
      profileId: profile.id
    }
    
  } catch (error) {
    console.error('❌ Auth Helper: Failed to get current user:', error)
    throw new Error('Authentication required')
  }
}

/**
 * Get current user's profile ID efficiently
 * This is the most commonly needed value in services
 */
export async function getCurrentUserProfileId(): Promise<string> {
  const authUser = await getCurrentAuthUser()
  return authUser.profileId
}

/**
 * Get current user's auth ID efficiently  
 * Used for auth-related operations
 */
export async function getCurrentUserAuthId(): Promise<string> {
  const authUser = await getCurrentAuthUser()
  return authUser.id
}

/**
 * Check if user is authenticated without expensive operations
 */
export function isAuthenticated(): boolean {
  try {
    // Check userDataService first
    const currentUser = userDataService.getCurrentUser()
    if (currentUser?.auth_user_id) {
      return true
    }

    // Check auth store
    const authStore = useAuthStore()
    return !!authStore.session?.user?.id
  } catch {
    return false
  }
}