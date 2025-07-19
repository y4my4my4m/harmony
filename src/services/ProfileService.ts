/**
 * ProfileService - Orchestrated profile management
 * 
 * ORCHESTRATION PATTERN: Combines Core + Federation services
 * - CoreProfileService: Pure local database operations
 * - FederationDecisionService: Federation decision logic
 * - FederationActivityService: ActivityPub activity creation
 * 
 * PRESERVED APIs: 
 * - ✅ Same method signatures as before
 * - ✅ Same return types and error formats
 * - ✅ Same userDataService integration
 * - ✅ Same local-first design (immediate UI updates)
 * 
 * ENHANCED ARCHITECTURE:
 * - Clean separation of concerns
 * - Testable service components
 * - Professional orchestration patterns
 */

import { supabase } from '@/supabase'
import { userDataService } from './userDataService'
import type { Profile } from '@/types'

// Import core and federation services
import { coreProfileService } from './core'
import { federationDecisionService, federationActivityService } from './federation'

export interface ProfileServiceError {
  code: string
  message: string
  details?: any
}

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
    if (!this.instance) {
      this.instance = new ProfileService()
    }
    return this.instance
  }

  // =====================================================
  // PROFILE FETCHING (DELEGATED TO CORE SERVICE)
  // =====================================================

  /**
   * Fetch user profile with smart caching (delegated to core service)
   * PRESERVES: Exact same API and userDataService integration
   */
  async fetchProfile(userId: string, useCache = true): Promise<Profile | null> {
    try {
      console.log(`🎭 Orchestration: Fetching profile for user: ${userId}`)

      // Use userDataService for cached profile data (preserve existing caching logic)
      if (useCache) {
        const cachedProfile = userDataService.getUserProfile(userId)
        if (cachedProfile && cachedProfile.username) {
          console.log('✅ Orchestration: Using cached profile for user:', userId)
          return this.transformToProfile(cachedProfile)
        }
      }

      // Delegate fresh fetch to core service
      console.log('🔄 Orchestration: Fetching fresh profile via core service')
      const userData = await userDataService.fetchUserProfile(userId, !useCache)
      
      if (userData) {
        console.log(`✅ Orchestration: Profile fetched successfully: ${userId}`)
        return this.transformToProfile(userData)
      }

      console.log(`ℹ️ Orchestration: Profile not found: ${userId}`)
      return null

    } catch (error) {
      console.error('❌ Orchestration: Error fetching profile:', error)
      throw this.createError('FETCH_FAILED', 'Failed to fetch user profile', error)
    }
  }

  /**
   * Fetch profile by auth user ID (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async fetchProfileByAuthUserId(authUserId: string): Promise<Profile | null> {
    try {
      console.log(`🎭 Orchestration: Fetching profile by auth user ID: ${authUserId}`)
      
      // Delegate to core service (no federation needed for reads)
      const profile = await coreProfileService.fetchProfileByAuthUserId(authUserId)

      if (profile) {
        console.log(`✅ Orchestration: Profile fetched by auth user ID: ${profile.id}`)
      } else {
        console.log(`ℹ️ Orchestration: No profile found for auth user ID: ${authUserId}`)
      }

      return profile

    } catch (error) {
      console.error('❌ Orchestration: Error fetching profile by auth user ID:', error)
      throw this.createError('FETCH_BY_AUTH_FAILED', 'Failed to fetch profile by auth user ID', error)
    }
  }

  // =====================================================
  // PROFILE MANAGEMENT (ORCHESTRATED: CORE + FEDERATION)
  // =====================================================

  /**
   * Update current user profile (orchestrated: local-first + conditional federation)
   * PRESERVES: Exact same API, userDataService integration, and return type
   */
  async updateProfile(profileData: ProfileData): Promise<Profile> {
    try {
      console.log('🎭 Orchestration: Updating current user profile:', profileData)

      // Get current user ID for federation decisions
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // 1. Core operation: Pure local profile update + userDataService sync
      const updatedProfile = await coreProfileService.updateProfile(profileData)

      // Update userDataService cache and broadcast to all contexts (preserve existing integration)
      await userDataService.updateCurrentUserProfile({
        username: profileData.username,
        displayName: profileData.display_name,
        avatarUrl: profileData.avatar_url,
        bannerUrl: profileData.banner_url,
        bio: profileData.bio,
        color: profileData.color
      })

      // 2. Federation decision: Should this profile update federate?
      const decision = await federationDecisionService.shouldFederateProfile(profileId, 'update')
      
      if (decision.shouldFederate) {
        console.log(`📤 Orchestration: Profile update eligible for federation: ${decision.reason}`)
        
        // 3. Federation operation: Create ActivityPub Update activity
        const activityResult = await federationActivityService.createProfileActivity(profileId, 'update')
        
        if (activityResult.success) {
          console.log(`✅ Orchestration: Profile update federation activity created: ${activityResult.activityId}`)
        } else {
          console.warn(`⚠️ Orchestration: Profile update federation failed (update still applied locally): ${activityResult.error}`)
        }
      } else {
        console.log(`ℹ️ Orchestration: Profile update federation skipped: ${decision.reason}`)
      }

      console.log('✅ Orchestration: Profile updated successfully:', updatedProfile.id)
      return updatedProfile

    } catch (error) {
      console.error('❌ Orchestration: Error updating profile:', error)
      throw this.createError('UPDATE_FAILED', 'Failed to update profile', error)
    }
  }

  /**
   * Create new user profile (orchestrated: local-first + conditional federation)
   * PRESERVES: Exact same API and return type
   */
  async createProfile(profileData: Profile): Promise<Profile> {
    try {
      console.log('🎭 Orchestration: Creating new user profile:', profileData.username)

      // 1. Core operation: Pure local profile creation
      const newProfile = await coreProfileService.createProfile(profileData)

      // 2. Federation decision: Should this profile creation federate?
      const decision = await federationDecisionService.shouldFederateProfile(newProfile.id, 'create')
      
      if (decision.shouldFederate) {
        console.log(`📤 Orchestration: Profile creation eligible for federation: ${decision.reason}`)
        
        // 3. Federation operation: Create ActivityPub Person activity
        const activityResult = await federationActivityService.createProfileActivity(newProfile.id, 'create')
        
        if (activityResult.success) {
          console.log(`✅ Orchestration: Profile creation federation activity created: ${activityResult.activityId}`)
        } else {
          console.warn(`⚠️ Orchestration: Profile creation federation failed (profile still created locally): ${activityResult.error}`)
        }
      } else {
        console.log(`ℹ️ Orchestration: Profile creation federation skipped: ${decision.reason}`)
      }

      console.log('✅ Orchestration: Profile created successfully:', newProfile.id)
      return newProfile

    } catch (error) {
      console.error('❌ Orchestration: Error creating profile:', error)
      throw this.createError('CREATE_FAILED', 'Failed to create profile', error)
    }
  }

  // =====================================================
  // UTILITY METHODS (PRESERVED)
  // =====================================================

  /**
   * Check if profile is complete (has required fields)
   * PRESERVES: Exact same logic
   */
  isProfileComplete(profile: Profile | null): boolean {
    return !!(profile && profile.username && profile.display_name)
  }

  /**
   * Transform userDataService format to Profile format
   * PRESERVES: Exact same transformation logic
   */
  private transformToProfile(userData: any): Profile {
    return {
      id: userData.id,
      auth_user_id: userData.authUserId,
      username: userData.username,
      display_name: userData.displayName || userData.username,
      avatar_url: userData.avatarUrl || '/default_avatar.png',
      banner_url: userData.bannerUrl,
      bio: userData.bio || '',
      color: userData.color,
      domain: userData.domain || 'har.mony.lol',
      is_local: userData.isLocal !== false,
      followers_count: userData.followersCount || 0,
      following_count: userData.followingCount || 0,
      posts_count: userData.postsCount || 0,
      created_at: userData.createdAt,
      updated_at: userData.updatedAt || userData.createdAt
    }
  }

  /**
   * Get current user's profile ID
   * PRESERVES: Exact same helper logic
   */
  private async getCurrentUserProfileId(): Promise<string> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('auth_user_id', user.id)
        .single()

      if (!profile) throw this.createError('PROFILE_NOT_FOUND', 'User profile not found')

      return profile.id
    } catch (error) {
      console.error('❌ Orchestration: Failed to get current user profile ID:', error)
      throw error
    }
  }

  /**
   * Create standardized error object
   * PRESERVES: Exact same error handling
   */
  private createError(code: string, message: string, details?: any): ProfileServiceError {
    const secureDetails = process.env.NODE_ENV === 'development' ? details : undefined
    return { code, message, details: secureDetails }
  }
}

// Export singleton instance
export const profileService = ProfileService.getInstance()