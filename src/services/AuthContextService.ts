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
        .maybeSingle()

      if (profileError && profileError.code !== 'PGRST116') {
        debug.error('Error loading profile:', profileError)
        // Transient DB error - don't cache. The next call should retry.
        return this.createUnauthenticatedContext()
      }

      if (!profile) {
        // The auth user exists but the profile row doesn't yet (e.g. brand-new
        // signup that hasn't completed the NewProfile.vue flow, or a refresh
        // landing on /new-profile). This is a TRANSIENT state - the profile
        // will be created moments later when the user submits the form.
        //
        // We must NOT cache `unauthenticated` here, because any code that
        // races and populates the cache before profile creation (e.g.
        // `activityPubStore.loadBlockingData()` called from auth.ts SIGNED_IN
        // / initializeAuth) would poison the cache. The next call after
        // profile creation would then return the stale `unauthenticated`
        // state, causing `ProfileService.updateCurrentProfile` to throw
        // AUTH_REQUIRED. Result: avatar upload succeeds (file lands in R2)
        // but the avatar_url UPDATE never runs, so profiles.avatar_url stays
        // at its DB DEFAULT (`/default_avatar.webp`). See investigation
        // around 2026-05-27.
        debug.warn('Auth user found but no profile exists (transient, not caching):', user.id)
        return this.createUnauthenticatedContext()
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
      // Don't cache on unexpected failure - let the next call retry.
      return this.createUnauthenticatedContext()
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
   * ONLY clears on actual user changes, not token refreshes or tab visibility changes
   */
  initializeAuthListener(): void {
    supabase.auth.onAuthStateChange((event, session) => {
      // Only clear cache when the ACTUAL USER changes
      // TOKEN_REFRESHED just refreshes the access token - same user, keep cache
      // SIGNED_IN on tab visible is just Supabase reconnecting - same user, keep cache
      
      if (event === 'SIGNED_OUT') {
        debug.log('🔄 Auth state: SIGNED_OUT - clearing cache')
        this.clearCache()
        return
      }
      
      if (event === 'USER_UPDATED') {
        debug.log('🔄 Auth state: USER_UPDATED - clearing cache')
        this.clearCache()
        return
      }
      
      // For SIGNED_IN, clear cache if:
      // 1. Cache contains unauthenticated state (user was logged out)
      // 2. Different user is signing in
      if (event === 'SIGNED_IN') {
        const newUserId = session?.user?.id
        const cachedUserId = this.cachedContext?.authUser?.id
        
        if (!this.cachedContext?.isAuthenticated || (cachedUserId && cachedUserId !== newUserId)) {
          debug.log('🔐 SIGNED_IN - clearing cache (unauthenticated or different user)')
          this.clearCache()
        }
        return
      }
      
      // TOKEN_REFRESHED, INITIAL_SESSION, etc: No action needed
      // These don't change who the user is
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

authContextService.initializeAuthListener()
