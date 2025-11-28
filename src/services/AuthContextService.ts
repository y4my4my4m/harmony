/**
 * AuthContextService - Centralized authentication and profile resolution
 * 
 * This service solves the massive problem of every service doing the same auth lookup:
 * - Single source of truth for current user authentication
 * - Caches auth_user_id → profile.id mapping
 * - Provides global access to current user context
 * - Eliminates hundreds of duplicate database queries
 * 
 * BEFORE: 21+ services all doing:
 * ```
 * const { data: { user } } = await supabase.auth.getUser()
 * const { data: profile } = await supabase.from('profiles').select('id').eq('auth_user_id', user.id).single()
 * ```
 * 
 * AFTER: One lookup, cached globally:
 * ```
 * const profileId = await authContextService.getCurrentProfileId()
 * ```
 */

import { supabase } from '@/supabase'
import type { User } from '@supabase/supabase-js'
import { debug } from '@/utils/debug'

export interface AuthContext {
  authUser: User
  profileId: string
  isAuthenticated: true
}

export interface UnauthenticatedContext {
  authUser: null
  profileId: null
  isAuthenticated: false
}

export type UserContext = AuthContext | UnauthenticatedContext

export class AuthContextService {
  private static instance: AuthContextService
  private cachedContext: UserContext | null = null
  private isLoading = false
  
  static getInstance(): AuthContextService {
    if (!this.instance) {
      this.instance = new AuthContextService()
    }
    return this.instance
  }

  /**
   * Get current user context (auth + profile ID)
   * Caches the result to avoid repeated database queries
   */
  async getCurrentContext(): Promise<UserContext> {
    // Return cached context if available
    if (this.cachedContext) {
      return this.cachedContext
    }

    // Prevent concurrent requests
    if (this.isLoading) {
      await this.waitForLoading()
      return this.cachedContext || this.createUnauthenticatedContext()
    }

    this.isLoading = true

    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser()
      
      if (authError || !user) {
        this.cachedContext = this.createUnauthenticatedContext()
        return this.cachedContext
      }

      // Resolve profile ID from auth user ID
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('id')
        .eq('auth_user_id', user.id)
        .single()

      if (profileError || !profile) {
        debug.warn('Auth user found but no profile exists:', user.id)
        this.cachedContext = this.createUnauthenticatedContext()
        return this.cachedContext
      }

      this.cachedContext = {
        authUser: user,
        profileId: profile.id,
        isAuthenticated: true
      }

      debug.log(`✅ Auth context resolved: ${user.id} → ${profile.id}`)
      return this.cachedContext

    } catch (error) {
      debug.error('❌ Failed to resolve auth context:', error)
      this.cachedContext = this.createUnauthenticatedContext()
      return this.cachedContext
    } finally {
      this.isLoading = false
    }
  }

  /**
   * Get current profile ID (the most commonly needed value)
   * Throws if user is not authenticated
   */
  async getCurrentProfileId(): Promise<string> {
    const context = await this.getCurrentContext()
    
    if (!context.isAuthenticated) {
      throw new Error('User not authenticated')
    }
    
    return context.profileId
  }

  /**
   * Get current auth user
   * Throws if user is not authenticated
   */
  async getCurrentAuthUser(): Promise<User> {
    const context = await this.getCurrentContext()
    
    if (!context.isAuthenticated) {
      throw new Error('User not authenticated')
    }
    
    return context.authUser
  }

  /**
   * Check if user is authenticated without throwing
   */
  async isAuthenticated(): Promise<boolean> {
    const context = await this.getCurrentContext()
    return context.isAuthenticated
  }

  /**
   * Clear cached context (call on auth state changes)
   */
  clearCache(): void {
    this.cachedContext = null
    debug.log('🧹 Auth context cache cleared')
  }

  /**
   * Initialize auth state listener to automatically clear cache
   * Only clears on actual auth changes, not initial session loads
   */
  initializeAuthListener(): void {
    supabase.auth.onAuthStateChange((event, session) => {
      debug.log(`🔄 Auth state changed: ${event}`)
      
      // Always clear cache on sign out or user updates
      if (event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        this.clearCache()
        return
      }
      
      // On SIGNED_IN, verify the cached user matches the new session
      // This prevents security issues where a different user signs in
      if (event === 'SIGNED_IN') {
        const newUserId = session?.user?.id
        const cachedUserId = this.cachedContext?.authUser?.id
        
        if (cachedUserId && cachedUserId !== newUserId) {
          // Different user signed in - MUST clear cache for security
          debug.log('🔐 Different user signed in, clearing stale cache')
          this.clearCache()
        } else if (!this.cachedContext) {
          debug.log('🔄 Fresh sign-in detected, cache will be populated on first request')
        }
        // Same user - keep cache (e.g., page refresh with existing session)
        return
      }
      
      // INITIAL_SESSION: Skip cache clear - let existing cache persist
      // PASSWORD_RECOVERY: User is still logged in, keep cache
      // MFA_CHALLENGE_VERIFIED: Still same user, keep cache
    })
  }

  // Private helper methods
  private createUnauthenticatedContext(): UnauthenticatedContext {
    return {
      authUser: null,
      profileId: null,
      isAuthenticated: false
    }
  }

  private async waitForLoading(): Promise<void> {
    while (this.isLoading) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

// Export singleton instance
export const authContextService = AuthContextService.getInstance()

// Initialize auth listener on module load
authContextService.initializeAuthListener()
