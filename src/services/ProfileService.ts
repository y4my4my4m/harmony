/**
 * ProfileService - Simplified profile management (TRUSTS DATABASE TRIGGERS)
 * 
 * OPTIMIZATION: Simplified to trust your excellent database federation triggers
 * - CoreProfileService: Pure local database operations
 * - Database triggers: handle_profile_federation() (if exists) 
 * - NO manual federation decisions or activity creation needed
 * 
 * PRESERVED APIs: 
 * - ✅ Same method signatures as before
 * - ✅ Same return types and error formats
 * - ✅ Same userDataService integration
 * - ✅ Same local-first design (immediate UI updates)
 * 
 * SIMPLIFIED ARCHITECTURE:
 * - Trust database triggers for all federation
 * - Eliminate unnecessary federation service calls
 * - Reduce database round trips significantly
 */

import { supabase } from '@/supabase'
import { userDataService } from './userDataService'
import type { Profile } from '@/types'

// Import only core service - database handles federation
import { coreProfileService } from './core'

export interface ProfileData {
  username?: string
  display_name?: string
  avatar_url?: string
  banner_url?: string
  bio?: string
  color?: string
}

export class ProfileService {
  private static instance: ProfileService

  static getInstance(): ProfileService {
    if (!ProfileService.instance) {
      ProfileService.instance = new ProfileService()
    }
    return ProfileService.instance
  }

  // =====================================================
  // PROFILE MANAGEMENT (SIMPLIFIED: TRUST DATABASE)
  // =====================================================

  /**
   * Get current user's profile (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async getCurrentProfile(): Promise<Profile> {
    try {
      console.log(`🚀 Simplified: Getting current user profile`)

      // Delegate to core service (no federation needed for reads)
      const profile = await coreProfileService.getCurrentProfile()

      console.log(`✅ Simplified: Current profile loaded successfully`)
      return profile

    } catch (error) {
      console.error('❌ Simplified: Failed to get current profile:', error)
      throw error
    }
  }

  /**
   * Update current user's profile (simplified: database triggers handle federation)
   * PRESERVES: Exact same API and return type
   */
  async updateCurrentProfile(updates: ProfileData): Promise<Profile> {
    try {
      console.log(`🚀 Simplified: Updating current user profile`)

      // Just update the profile - database triggers handle federation automatically
      const profile = await coreProfileService.updateCurrentProfile(updates)

      // Update userDataService cache with fresh profile data
      try {
        await userDataService.refreshCurrentUser()
        console.log('✅ Simplified: UserDataService cache refreshed')
      } catch (refreshError) {
        console.warn('⚠️ Simplified: Failed to refresh userDataService cache:', refreshError)
        // Don't fail the whole operation if cache refresh fails
      }

      console.log(`✅ Simplified: Profile updated successfully - database handling federation`)
      return profile

    } catch (error) {
      console.error('❌ Simplified: Failed to update profile:', error)
      throw error
    }
  }

  /**
   * Create a new profile (simplified: database triggers handle federation)
   * PRESERVES: Exact same API and return type
   */
  async createProfile(profileData: ProfileData & { auth_user_id: string }): Promise<Profile> {
    try {
      console.log(`🚀 Simplified: Creating new profile`)

      // Just create the profile - database triggers handle federation automatically
      const profile = await coreProfileService.createProfile(profileData)

      // Initialize userDataService with new profile
      try {
        await userDataService.refreshCurrentUser()
        console.log('✅ Simplified: UserDataService initialized with new profile')
      } catch (initError) {
        console.warn('⚠️ Simplified: Failed to initialize userDataService:', initError)
        // Don't fail profile creation if cache init fails
      }

      console.log(`✅ Simplified: Profile created successfully - database handling federation`)
      return profile

    } catch (error) {
      console.error('❌ Simplified: Failed to create profile:', error)
      throw error
    }
  }

  // =====================================================
  // PROFILE QUERIES (DELEGATED TO CORE SERVICE)
  // =====================================================

  /**
   * Get profile by ID (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async getProfileById(profileId: string): Promise<Profile> {
    try {
      console.log(`🚀 Simplified: Getting profile by ID: ${profileId}`)

      // Delegate to core service (no federation needed for reads)
      const profile = await coreProfileService.getProfileById(profileId)

      console.log(`✅ Simplified: Profile loaded successfully`)
      return profile

    } catch (error) {
      console.error('❌ Simplified: Failed to get profile by ID:', error)
      throw error
    }
  }

  /**
   * Get profile by username (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async getProfileByUsername(username: string, domain?: string): Promise<Profile> {
    try {
      console.log(`🚀 Simplified: Getting profile by username: ${username}@${domain || 'local'}`)

      // Delegate to core service (no federation needed for reads)
      const profile = await coreProfileService.getProfileByUsername(username, domain)

      console.log(`✅ Simplified: Profile loaded successfully`)
      return profile

    } catch (error) {
      console.error('❌ Simplified: Failed to get profile by username:', error)
      throw error
    }
  }

  /**
   * Search profiles (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async searchProfiles(
    query: string,
    options: {
      limit?: number;
      offset?: number;
      includeFederated?: boolean;
    } = {}
  ): Promise<{
    profiles: Profile[];
    hasMore: boolean;
    total: number;
  }> {
    try {
      console.log(`🚀 Simplified: Searching profiles: "${query}"`)

      // Delegate to core service (no federation needed for reads)
      const result = await coreProfileService.searchProfiles(query, options)

      console.log(`✅ Simplified: Found ${result.profiles.length} profiles`)
      return result

    } catch (error) {
      console.error('❌ Simplified: Failed to search profiles:', error)
      throw error
    }
  }

  // =====================================================
  // PROFILE VALIDATION (DELEGATED TO CORE SERVICE)
  // =====================================================

  /**
   * Check username availability (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async checkUsernameAvailability(username: string): Promise<{
    available: boolean;
    reason?: string;
  }> {
    try {
      console.log(`🚀 Simplified: Checking username availability: ${username}`)

      // Delegate to core service (no federation needed for validation)
      const result = await coreProfileService.checkUsernameAvailability(username)

      console.log(`✅ Simplified: Username availability checked`)
      return result

    } catch (error) {
      console.error('❌ Simplified: Failed to check username availability:', error)
      throw error
    }
  }

  // =====================================================
  // UTILITY METHODS (PRESERVED)
  // =====================================================

  private async getCurrentUserProfileId(): Promise<string> {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single()

    if (error || !profile) {
      throw this.createError('PROFILE_NOT_FOUND', 'User profile not found')
    }

    return profile.id
  }

  private createError(code: string, message: string, details?: any): Error {
    const error = new Error(message) as any
    error.code = code
    error.details = details
    return error
  }
}

// Export singleton instance
export const profileService = ProfileService.getInstance()