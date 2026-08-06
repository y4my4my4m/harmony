/**
 * Single source of truth for the current auth user and the
 * auth_user_id → profiles.id mapping. Cached process-wide.
 *
 * Callers use `authContextService.getCurrentProfileId()` rather than issuing
 * their own `supabase.auth.getUser()` + profiles lookup.
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

  /** Resolves and caches the auth user plus profile id. */
  async getCurrentContext(): Promise<UserContext> {
    if (this.cachedContext) {
      return this.cachedContext
    }

    // Concurrent callers wait on the in-flight resolution.
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

      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('id')
        .eq('auth_user_id', user.id)
        .maybeSingle()

      if (profileError && profileError.code !== 'PGRST116') {
        debug.error('Error loading profile:', profileError)
        // Transient DB error; not cached, so the next call retries.
        return this.createUnauthenticatedContext()
      }

      if (!profile) {
        // Auth user exists without a profile row during signup, before the
        // NewProfile.vue flow completes. Transient.
        //
        // CRITICAL: this state must not be cached. A racing caller such as
        // `activityPubStore.loadBlockingData()` (from auth.ts SIGNED_IN /
        // initializeAuth) would pin `unauthenticated` in the cache; after
        // profile creation `ProfileService.updateCurrentProfile` then throws
        // AUTH_REQUIRED, so an uploaded avatar lands in R2 while
        // profiles.avatar_url keeps its DB default `/default_avatar.webp`.
        debug.warn('Auth user found but no profile exists (transient, not caching):', user.id)
        return this.createUnauthenticatedContext()
      }

      this.cachedContext = {
        authUser: user,
        profileId: profile.id,
        isAuthenticated: true
      }

      debug.log(`Auth context resolved: ${user.id} → ${profile.id}`)
      return this.cachedContext

    } catch (error) {
      debug.error('Failed to resolve auth context:', error)
      // Unexpected failure; not cached, so the next call retries.
      return this.createUnauthenticatedContext()
    } finally {
      this.isLoading = false
    }
  }

  /** Throws when unauthenticated. */
  async getCurrentProfileId(): Promise<string> {
    const context = await this.getCurrentContext()
    
    if (!context.isAuthenticated) {
      throw new Error('User not authenticated')
    }
    
    return context.profileId
  }

  /** Throws when unauthenticated. */
  async getCurrentAuthUser(): Promise<User> {
    const context = await this.getCurrentContext()
    
    if (!context.isAuthenticated) {
      throw new Error('User not authenticated')
    }
    
    return context.authUser
  }

  async isAuthenticated(): Promise<boolean> {
    const context = await this.getCurrentContext()
    return context.isAuthenticated
  }

  clearCache(): void {
    this.cachedContext = null
    debug.log('Auth context cache cleared')
  }

  /**
   * Clears the cache only when the identity changes.
   * TOKEN_REFRESHED and tab-visibility SIGNED_IN events keep the same user, so
   * the cache survives them.
   */
  initializeAuthListener(): void {
    supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        debug.log('Auth state: SIGNED_OUT - clearing cache')
        this.clearCache()
        return
      }
      
      if (event === 'USER_UPDATED') {
        debug.log('Auth state: USER_UPDATED - clearing cache')
        this.clearCache()
        return
      }
      
      // SIGNED_IN clears the cache when it holds an unauthenticated state or a
      // different user id.
      if (event === 'SIGNED_IN') {
        const newUserId = session?.user?.id
        const cachedUserId = this.cachedContext?.authUser?.id
        
        if (!this.cachedContext?.isAuthenticated || (cachedUserId && cachedUserId !== newUserId)) {
          debug.log('SIGNED_IN - clearing cache (unauthenticated or different user)')
          this.clearCache()
        }
        return
      }
      
      // TOKEN_REFRESHED, INITIAL_SESSION and the rest do not change identity.
    })
  }

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

export const authContextService = AuthContextService.getInstance()

authContextService.initializeAuthListener()
