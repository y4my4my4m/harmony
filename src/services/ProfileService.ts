/**
 * ProfileService - Local-first profile management
 * 
 * Wraps userDataService and provides comprehensive profile management:
 * - Fetches and caches user profiles
 * - Updates current user profile with real-time broadcasting
 * - Creates new profiles for registration
 * - Consistent error handling and loading states
 */

import { supabase } from '@/supabase'
import { userDataService } from './userDataService'
import type { Profile } from '@/types'

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
  // PROFILE FETCHING (LOCAL-FIRST)
  // =====================================================

  /**
   * Fetch user profile with smart caching
   */
  async fetchProfile(userId: string, useCache = true): Promise<Profile | null> {
    try {
      // Use userDataService for cached profile data
      if (useCache) {
        const cachedProfile = userDataService.getUserProfile(userId)
        if (cachedProfile && cachedProfile.username) {
          console.log('✅ Using cached profile for user:', userId)
          return this.transformToProfile(cachedProfile)
        }
      }

      // Force fetch if not cached or cache disabled
      console.log('🔄 Fetching fresh profile for user:', userId)
      const userData = await userDataService.fetchUserProfile(userId, !useCache)
      
      if (userData) {
        return this.transformToProfile(userData)
      }

      return null
    } catch (error) {
      console.error('❌ Error fetching profile:', error)
      throw this.createError('FETCH_FAILED', 'Failed to fetch user profile', error)
    }
  }

  /**
   * Fetch profile by auth user ID (for current user during login)
   */
  async fetchProfileByAuthUserId(authUserId: string): Promise<Profile | null> {
    try {
      console.log('🔄 Fetching profile by auth user ID:', authUserId)
      
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('auth_user_id', authUserId)
        .single()

      if (error && error.code !== 'PGRST116') {
        throw error
      }

      if (data) {
        // userDataService will automatically cache when the user is loaded
        console.log('✅ Profile fetched by auth user ID:', data.id)
      }

      return data as Profile || null
    } catch (error) {
      console.error('❌ Error fetching profile by auth user ID:', error)
      throw this.createError('FETCH_BY_AUTH_FAILED', 'Failed to fetch profile by auth user ID', error)
    }
  }

  // =====================================================
  // PROFILE MANAGEMENT (LOCAL-FIRST) 
  // =====================================================

  /**
   * Update current user profile (local-first with real-time sync)
   */
  async updateProfile(profileData: ProfileData): Promise<Profile> {
    try {
      console.log('🔄 Updating current user profile:', profileData)

      // Get current user ID
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Update in database first
      const { data, error } = await supabase
        .from('profiles')
        .update({
          username: profileData.username,
          display_name: profileData.display_name,
          avatar_url: profileData.avatar_url,
          banner_url: profileData.banner_url,
          bio: profileData.bio,
          color: profileData.color,
          updated_at: new Date().toISOString()
        })
        .eq('id', profileId)
        .select()
        .single()

      if (error) throw error

      // Update userDataService cache and broadcast to all contexts
      await userDataService.updateCurrentUserProfile({
        username: profileData.username,
        displayName: profileData.display_name,
        avatarUrl: profileData.avatar_url,
        bannerUrl: profileData.banner_url,
        bio: profileData.bio,
        color: profileData.color
      })

      console.log('✅ Profile updated successfully')
      return data as Profile
    } catch (error) {
      console.error('❌ Error updating profile:', error)
      throw this.createError('UPDATE_FAILED', 'Failed to update profile', error)
    }
  }

  /**
   * Create new user profile (for registration)
   */
  async createProfile(profileData: Profile): Promise<Profile> {
    try {
      console.log('🔄 Creating new user profile:', profileData.username)

      const { data, error } = await supabase
        .from('profiles')
        .insert([{
          ...profileData,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }])
        .select()
        .single()

      if (error) {
        console.error('❌ Supabase error creating profile:', error)
        throw error
      }

      // userDataService will automatically cache when the user is loaded
      console.log('✅ Profile created successfully:', data.id)
      return data as Profile
    } catch (error) {
      console.error('❌ Error creating profile:', error)
      throw this.createError('CREATE_FAILED', 'Failed to create profile', error)
    }
  }

  // =====================================================
  // UTILITY METHODS
  // =====================================================

  /**
   * Check if profile is complete (has required fields)
   */
  isProfileComplete(profile: Profile | null): boolean {
    return !!(profile && profile.username && profile.display_name)
  }

  /**
   * Get current user's profile ID
   */
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

  /**
   * Transform UserData to Profile format
   */
  private transformToProfile(userData: any): Profile {
    return {
      id: userData.id,
      username: userData.username,
      display_name: userData.displayName,
      avatar_url: userData.avatarUrl,
      banner_url: userData.bannerUrl,
      bio: userData.bio,
      color: userData.color,
      domain: userData.domain,
      is_local: userData.isLocal,
      status: userData.status,
      created_at: userData.createdAt,
      updated_at: userData.updatedAt,
      auth_user_id: userData.authUserId // if available
    }
  }

  /**
   * Create standardized error
   */
  private createError(code: string, message: string, details?: any): ProfileServiceError {
    return { code, message, details }
  }
}

// Export singleton instance
export const profileService = ProfileService.getInstance()